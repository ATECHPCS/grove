import type { CommandDef } from "../types";

/**
 * Extensions commands — adding agents/sources and managing the
 * installed extension catalog. Selection-based operations (edit/delete a
 * specific row) are intentionally NOT registered: those belong to row
 * context menus, not global shortcuts.
 */
export const SKILLS_COMMANDS: CommandDef[] = [
  {
    id: "skills.tab.explore",
    name: "Extensions: Catalog",
    category: "Extensions",
    scope: "settings",
  },
  {
    id: "skills.tab.sources",
    name: "Extensions: Sources Tab",
    category: "Extensions",
    scope: "settings",
  },
  {
    id: "skills.tab.agents",
    name: "Extensions: Agents Tab",
    category: "Extensions",
    scope: "settings",
  },
  {
    id: "skills.agent.add",
    name: "Add Agent",
    category: "Skills",
    scope: "settings",
  },
  {
    id: "skills.source.add",
    name: "Add Source",
    category: "Skills",
    scope: "settings",
  },
  {
    id: "skills.source.syncAll",
    name: "Sync All Sources",
    category: "Skills",
    scope: "settings",
  },
  {
    id: "skills.skill.install",
    name: "Install Skill",
    category: "Skills",
    scope: "settings",
    defaultWhen: "skillAvailable",
  },
  {
    id: "skills.skill.uninstall",
    name: "Uninstall Skill",
    category: "Skills",
    scope: "settings",
    defaultWhen: "skillInstalled",
  },
  {
    id: "skills.skill.details",
    name: "Show Skill Details",
    category: "Skills",
    scope: "settings",
    defaultWhen: "skillSelected",
  },
];
