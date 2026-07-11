/** Node request headers → Web Headers (the shape the neutral auth surface expects). */
export function headersFromNode(nodeHeaders: Record<string, string | string[] | undefined>): Headers {
  const pairs = Object.entries(nodeHeaders)
    .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
    .flatMap(([key, value]) =>
      Array.isArray(value) ? value.map(v => [key, v] as [string, string]) : [[key, value] as [string, string]],
    );
  return new Headers(pairs);
}
