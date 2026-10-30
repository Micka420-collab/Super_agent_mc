const HEADER = /^\/\*\*\s*@skill\s+(?<name>[\w-]+)\s*\n(?<meta>[\s\S]*?)\*\//;

export function parseSkillHeader(code: string): { name: string; description: string; tags: string[] } {
  const m = HEADER.exec(code);
  if (!m || !m.groups) return { name: '', description: '', tags: [] };
  let description = '';
  let tags: string[] = [];
  for (const raw of m.groups['meta']!.split('\n')) {
    const line = raw.trim().replace(/^\*\s?/, '');
    if (line.startsWith('description:')) description = line.slice('description:'.length).trim();
    if (line.startsWith('tags:')) tags = line.slice('tags:'.length).split(',').map((t) => t.trim()).filter(Boolean);
  }
  return { name: m.groups['name']!, description, tags };
}
