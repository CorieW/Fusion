/** FNXC:Duplicate 2026-09-07-04:09: Repeated copies need distinct, readable names. */
export function duplicateName(name: string, existingNames: Iterable<string>): string {
  const names = new Set(Array.from(existingNames, value => value.toLocaleLowerCase()));
  let candidate = name + " (copy)";
  let index = 2;
  while (names.has(candidate.toLocaleLowerCase())) candidate = name + " (copy " + index++ + ")";
  return candidate;
}
