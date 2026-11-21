// Notion's API, version 2026-03-11: pages as Markdown, data sources for databases.

export const NOTION_API = "https://api.notion.com";
/** The version Alter's Notion operation catalog is attested against. */
export const NOTION_VERSION = "2026-03-11";

/** Page and data source ids: 32 hex digits, with or without dashes. */
export const NOTION_ID = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;

/** Page text longer than this is cut, so one page cannot flood the model's context. */
export const MAX_READ_CHARS = 20_000;
export const MAX_WRITE_CHARS = 20_000;
export const MAX_COMMENT_CHARS = 2_000;

interface RichText {
  plain_text?: string;
}

export interface NotionProperty {
  type?: string;
  title?: RichText[];
  rich_text?: RichText[];
  select?: { name?: string } | null;
  status?: { name?: string } | null;
  multi_select?: { name?: string }[];
  number?: number | null;
  checkbox?: boolean;
  url?: string | null;
  email?: string | null;
  phone_number?: string | null;
  date?: { start?: string; end?: string | null } | null;
  people?: { name?: string }[];
  relation?: unknown[];
}

export interface NotionObject {
  object?: string;
  id: string;
  url?: string;
  last_edited_time?: string;
  title?: RichText[];
  properties?: Record<string, NotionProperty>;
}

const plain = (parts: RichText[] | undefined) => (parts ?? []).map((part) => part.plain_text ?? "").join("");

/** A property's value as short text, or undefined when it is empty or not shown. */
export function propertyText(property: NotionProperty): string | undefined {
  switch (property.type) {
    case "title":
      return plain(property.title) || undefined;
    case "rich_text":
      return plain(property.rich_text) || undefined;
    case "select":
      return property.select?.name;
    case "status":
      return property.status?.name;
    case "multi_select":
      return property.multi_select?.map((option) => option.name).filter(Boolean).join(", ") || undefined;
    case "number":
      return property.number === null || property.number === undefined ? undefined : String(property.number);
    case "checkbox":
      return property.checkbox ? "yes" : "no";
    case "url":
      return property.url ?? undefined;
    case "email":
      return property.email ?? undefined;
    case "phone_number":
      return property.phone_number ?? undefined;
    case "date":
      return property.date?.start ? `${property.date.start}${property.date.end ? ` to ${property.date.end}` : ""}` : undefined;
    case "people":
      return property.people?.map((person) => person.name).filter(Boolean).join(", ") || undefined;
    case "relation":
      return property.relation?.length ? `${property.relation.length} linked` : undefined;
    default:
      return undefined;
  }
}

export function titleOf(item: NotionObject): string {
  if (item.title) return plain(item.title) || "Untitled";
  const titleProperty = Object.values(item.properties ?? {}).find((property) => property.type === "title");
  return (titleProperty && plain(titleProperty.title)) || "Untitled";
}

/** The name of a data source's title property, which differs per database ("Name", "Title", ...). */
export function titlePropertyName(dataSource: NotionObject): string | undefined {
  return Object.entries(dataSource.properties ?? {}).find(([, property]) => property.type === "title")?.[0];
}

export function formatItem(item: NotionObject): string {
  const kind = item.object === "data_source" ? "database" : item.object ?? "item";
  return [`[${kind}] ${titleOf(item)}`, `id: ${item.id}`, ...(item.url ? [item.url] : []), ...(item.last_edited_time ? [`edited ${item.last_edited_time}`] : [])].join("\n");
}

/** A database row: its title and up to eight filled properties. */
export function formatRow(row: NotionObject): string {
  const fields = Object.entries(row.properties ?? {})
    .filter(([, property]) => property.type !== "title")
    .map(([name, property]) => [name, propertyText(property)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
    .slice(0, 8)
    .map(([name, value]) => `${name}: ${value}`);
  return [titleOf(row), `id: ${row.id}`, ...(row.url ? [row.url] : []), ...fields].join("\n");
}

/** Notion errors: {object: "error", code, message}. */
export function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: string; code?: string };
    return parsed.message ?? parsed.code ?? "";
  } catch {
    return "";
  }
}

export function truncate(text: string, max: number): { text: string; cut: boolean } {
  return text.length > max ? { text: text.slice(0, max), cut: true } : { text, cut: false };
}

// Writing values: plain values the agent gives, converted to Notion's
// per-type property formats using the page's or database's own schema.

/** A value for one property: text, a number, true/false, a list of names, or null to clear. */
export type PlainValue = string | number | boolean | string[] | null;

/** Column types `create_database` and `add_database_columns` can create. */
export const COLUMN_TYPES = [
  "text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "checkbox",
  "url",
  "email",
  "phone",
  "people",
] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export interface ColumnSpec {
  name: string;
  type: ColumnType;
  /** Choices for select, multi_select and status. */
  options?: string[];
}

const richText = (text: string) => [{ text: { content: text } }];

export class PropertyValueError extends Error {}

/**
 * The Notion request value for a property of `type`, from a plain value.
 * Dates are "YYYY-MM-DD" (or an ISO time), and a range is two dates in a list.
 */
export function propertyValue(name: string, type: string | undefined, value: PlainValue): unknown {
  const fail = (expected: string): never => {
    throw new PropertyValueError(`"${name}" is a ${type ?? "unknown"} property; give ${expected}.`);
  };
  const text = (v: PlainValue) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : fail("text"));
  switch (type) {
    case "title":
      return { title: value === null ? [] : richText(text(value)) };
    case "rich_text":
      return { rich_text: value === null ? [] : richText(text(value)) };
    case "number":
      if (value === null) return { number: null };
      if (typeof value === "number") return { number: value };
      if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return { number: Number(value) };
      return fail("a number");
    case "checkbox":
      if (typeof value === "boolean") return { checkbox: value };
      if (value === "true" || value === "false") return { checkbox: value === "true" };
      return fail("true or false");
    case "select":
      return { select: value === null ? null : { name: text(value) } };
    case "status":
      return { status: value === null ? null : { name: text(value) } };
    case "multi_select": {
      if (value === null) return { multi_select: [] };
      const names = Array.isArray(value) ? value : typeof value === "string" ? value.split(",").map((part) => part.trim()).filter(Boolean) : fail("a list of names");
      return { multi_select: names.map((option) => ({ name: option })) };
    }
    case "date": {
      if (value === null) return { date: null };
      const [start, end] = Array.isArray(value) ? value : [text(value)];
      if (!start || Number.isNaN(Date.parse(start)) || (end !== undefined && Number.isNaN(Date.parse(end)))) {
        return fail('a date like "2026-11-21", or a list of two dates for a range');
      }
      return { date: { start, ...(end ? { end } : {}) } };
    }
    case "url":
      return { url: value === null ? null : text(value) };
    case "email":
      return { email: value === null ? null : text(value) };
    case "phone_number":
      return { phone_number: value === null ? null : text(value) };
    case "relation": {
      if (value === null) return { relation: [] };
      const ids = Array.isArray(value) ? value : [text(value)];
      if (!ids.every((id) => NOTION_ID.test(id))) return fail("Notion page ids");
      return { relation: ids.map((id) => ({ id })) };
    }
    case "people": {
      if (value === null) return { people: [] };
      const ids = Array.isArray(value) ? value : [text(value)];
      if (!ids.every((id) => NOTION_ID.test(id))) return fail("Notion user ids (people are set by id)");
      return { people: ids.map((id) => ({ id })) };
    }
    default:
      return fail("nothing: it is computed by Notion or not supported here, so set it in Notion");
  }
}

/** Builds a `properties` object from plain values, using `schema` (name to property type). */
export function propertiesFrom(values: Record<string, PlainValue>, schema: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) {
    const type = schema[name];
    if (!type) {
      const known = Object.keys(schema).sort().join(", ");
      throw new PropertyValueError(`There is no property "${name}" here. Properties: ${known || "none"}.`);
    }
    out[name] = propertyValue(name, type, value);
  }
  return out;
}

/** The property-type map of a page or data source object (`properties` keyed by name, each with a `type`). */
export function schemaOf(object: { properties?: Record<string, { type?: string }> }): Record<string, string> {
  return Object.fromEntries(
    Object.entries(object.properties ?? {}).flatMap(([name, property]) => (property.type ? [[name, property.type]] : [])),
  );
}

const COLOURS = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;

/** The Notion property configuration for a column spec. */
export function columnConfig(column: ColumnSpec): unknown {
  const options = (column.options ?? []).map((name, index) => ({ name, color: COLOURS[(index + 1) % COLOURS.length] }));
  switch (column.type) {
    case "text":
      return { rich_text: {} };
    case "number":
      return { number: { format: "number" } };
    case "select":
      return { select: { options } };
    case "multi_select":
      return { multi_select: { options } };
    case "status":
      return { status: options.length > 0 ? { options } : {} };
    case "date":
      return { date: {} };
    case "checkbox":
      return { checkbox: {} };
    case "url":
      return { url: {} };
    case "email":
      return { email: {} };
    case "phone":
      return { phone_number: {} };
    case "people":
      return { people: {} };
  }
}
