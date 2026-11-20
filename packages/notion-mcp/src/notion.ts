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
