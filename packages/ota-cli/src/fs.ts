import { access } from 'node:fs/promises';

export async function isPresent(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
