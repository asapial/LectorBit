// Tiny `clsx`/`tailwind-merge` substitute so we don't pull another dependency.
// Joins truthy class strings and dedupes the trailing occurrence of each class.

export type ClassValue =
  | string
  | number
  | null
  | false
  | undefined
  | ClassValue[]
  | { [key: string]: boolean | null | undefined };

function flatten(value: ClassValue): string[] {
  if (value === null || value === undefined || value === false || value === '') {
    return [];
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap(flatten);
  }
  const out: string[] = [];
  for (const [key, active] of Object.entries(value)) {
    if (active) out.push(key);
  }
  return out;
}

/** Join class names, deduping the last occurrence of each token. */
export function cn(...inputs: ClassValue[]): string {
  const tokens = inputs.flatMap(flatten);
  const seen = new Map<string, number>();
  tokens.forEach((tok) => {
    const space = tok.lastIndexOf(' ');
    const base = space === -1 ? tok : tok.slice(0, space);
    const variant = space === -1 ? '' : tok.slice(space);
    const key = `${base}__${variant}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  });
  const counts = new Map<string, number>(seen);
  const out: string[] = [];
  for (const tok of tokens) {
    const space = tok.lastIndexOf(' ');
    const base = space === -1 ? tok : tok.slice(0, space);
    const variant = space === -1 ? '' : tok.slice(space);
    const key = `${base}__${variant}`;
    const remaining = counts.get(key) ?? 0;
    if (remaining > 0) {
      out.push(tok);
      counts.set(key, remaining - 1);
    }
  }
  return out.join(' ');
}