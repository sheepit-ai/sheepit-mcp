/**
 * Barrel for the vendored Sheepit API-contract schemas.
 *
 * Re-exports the symbols the MCP tools consume. These were previously
 * imported from an internal workspace package; they are vendored under `./`
 * so this package builds standalone. See `./README.md`.
 */

// Campaigns
export {
  archiveCampaignSchema,
  campaignListQuerySchema,
  completeCampaignSchema,
  createCampaignSchema,
  launchCampaignSchema,
  pauseCampaignSchema,
  resumeCampaignSchema,
  updateCampaignSchema,
} from "./campaign-schemas.js";

// Destinations
export {
  createDestinationSchema,
  destinationListQuerySchema,
  testDestinationSchema,
  updateDestinationSchema,
} from "./destination-schemas.js";

// User groups
export { createUserGroupSchema, userGroupListQuerySchema } from "./user-group-schemas.js";

// Flags
export { createFlagSchema, updateFlagSchema, flagListQuerySchema } from "./flag-schemas.js";

// Experiments
export {
  createExperimentSchema,
  updateExperimentSchema,
  experimentListQuerySchema,
} from "./experiment-schemas.js";

// Dashboards / widgets / insights
export {
  createDashboardSchema,
  updateDashboardSchema,
  dashboardListQuerySchema,
  createWidgetSchema,
  updateWidgetSchema,
  insightsQueryRequestSchema,
  templateIdSchema,
  dashboardMaterializeSchema,
  materializeWidgetSchema,
} from "./dashboard-schemas.js";

// Dashboard templates
export { DASHBOARD_TEMPLATE_BLUEPRINTS, findTemplateBlueprint } from "./dashboard-templates.js";
export type { DashboardTemplateBlueprint, DashboardTemplateWidget } from "./dashboard-templates.js";
