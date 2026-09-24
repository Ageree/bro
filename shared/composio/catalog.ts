import { z } from "zod";

/**
 * Apps besides Google a person connects with their own account through
 * Composio. Each id is also the Composio toolkit slug. Notion and Slack have
 * tools and a cabinet row of their own; the rest are reached through the
 * `apps` tool. Only these apps exist for Bro: anything else stays out even
 * when Composio offers it.
 */
export const connectedApps = [
  "airtable",
  "asana",
  "calendly",
  "clickup",
  "discord",
  "dropbox",
  "figma",
  "github",
  "hubspot",
  "linear",
  "miro",
  "notion",
  "outlook",
  "slack",
  "todoist",
  "trello",
  "zoom",
] as const;

export const connectedAppSchema = z.enum(connectedApps);

export type ConnectedApp = z.infer<typeof connectedAppSchema>;

/** Apps with a row of their own in the cabinet, where they connect too. */
export const cabinetAppSchema = z.enum(["notion", "slack"]);

export const connectedAppNames = {
  airtable: "Airtable",
  asana: "Asana",
  calendly: "Calendly",
  clickup: "ClickUp",
  discord: "Discord",
  dropbox: "Dropbox",
  figma: "Figma",
  github: "GitHub",
  hubspot: "HubSpot",
  linear: "Linear",
  miro: "Miro",
  notion: "Notion",
  outlook: "Outlook",
  slack: "Slack",
  todoist: "Todoist",
  trello: "Trello",
  zoom: "Zoom",
} as const satisfies Record<ConnectedApp, string>;
