import { basename } from 'node:path';

export function safeName(input: string): string {
  const name = basename(input.replace(/\\/g, '/')).replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 180);
  if (!name || name === '.' || name === '..' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return 'received-file';
  return name;
}
