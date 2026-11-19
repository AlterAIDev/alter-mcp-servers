# Security Policy

These servers sit between an AI agent and a person's email and social accounts. They hold an Alter agent key, never a provider token, and rely on Alter for policy, approvals and audit. We take reports seriously and appreciate responsible disclosure.

## Supported versions

This is a `0.x` project. Only the latest published version of each package receives security fixes.

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security problem.**

Report privately with GitHub's **Report a vulnerability** button under this repository's **Security** tab. If you cannot use that, email **security@alterauth.com** with a description and impact, the affected package and version, reproduction steps, and any suggested fix.

## In scope

- A way to make a server act outside the policies set on its agent, or to skip an approval.
- Header injection or message tampering in what the servers send to Gmail or LinkedIn.
- Leaking the agent key or provider data through logs or tool output.

Issues in Alter itself go to the same address.
