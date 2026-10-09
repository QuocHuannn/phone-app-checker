/** "1 number", "2 numbers": a count with its noun in the right form (English; `many` for irregular plurals). */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
