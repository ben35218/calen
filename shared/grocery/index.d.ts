export interface OrganizedItem {
  name: string;
  amount?: string;
  [key: string]: unknown;
}
export interface OrganizedCategory {
  name: string;
  aisle?: string;
  items?: OrganizedItem[];
  [key: string]: unknown;
}
export interface OrganizedList {
  store_known?: boolean;
  categories: OrganizedCategory[];
  [key: string]: unknown;
}

/** "extra virgin olive oil" -> "Extra Virgin Olive Oil". Casing only — nothing added or dropped. */
export function titleCase(raw: unknown): string;
/** "garlic cloves, minced" -> "Garlic Cloves"; "fresh basil leaves" -> "Basil". */
export function shopperName(raw: unknown): string;
/** "2 Tablespoons" -> "2 tbsp"; other units ride through untouched. */
export function shopperAmount(raw: unknown): string;
/** Clean every item name/amount in an organized list, merge collided names, drop empty sections. */
export function normalizeOrganizedList<T extends OrganizedList | null | undefined>(organized: T): T;
