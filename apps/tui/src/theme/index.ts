import source from "./assets/opencode.json" with { type: "json" };

type ThemeMode = "dark" | "light";

export function resolveTheme(mode: ThemeMode) {
  const definitions: Record<string, string> = source.defs;
  return Object.fromEntries(
    Object.entries(source.theme).map(([name, value]) => {
      const color = value[mode];
      return [name, definitions[color] ?? color];
    }),
  ) as { [Name in keyof typeof source.theme]: string };
}

export const theme = resolveTheme("dark");
