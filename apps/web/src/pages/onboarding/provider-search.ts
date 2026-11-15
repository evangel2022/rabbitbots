export type ProviderChoice = { value: string; label: string };

/** Case-insensitive provider search over the visible name and the provider/type value. */
export function filterProviderChoices(
  choices: readonly ProviderChoice[],
  query: string,
): ProviderChoice[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...choices];
  return choices.filter((choice) =>
    `${choice.label} ${choice.value}`.toLocaleLowerCase().includes(needle),
  );
}
