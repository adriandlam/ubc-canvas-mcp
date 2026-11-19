const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decodes `&name;`, `&#123;` and `&#x1F;` entities in HTML or XML text; unknown names are left as written. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity: string) => {
    if (entity[0] !== '#') return NAMED[entity] ?? match;
    const isHex = entity[1] === 'x' || entity[1] === 'X';
    return String.fromCodePoint(isHex ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
  });
}
