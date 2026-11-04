/// <reference types="node" />
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RGBAImage } from '../ai/image';
import { decodePng, encodePng, streamZlib } from '../ai/png';

/** A path inside the repo, from the repo root. */
export function repoPath(relative: string): string {
  return fileURLToPath(new URL(`../../${relative}`, import.meta.url));
}

export async function loadPng(path: string): Promise<RGBAImage> {
  return decodePng(new Uint8Array(readFileSync(path)), streamZlib);
}

export async function savePng(path: string, image: RGBAImage): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, await encodePng(image, streamZlib));
}

export function saveText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export function fileExists(path: string | undefined): path is string {
  return !!path && existsSync(path);
}

export function env(name: string): string | undefined {
  return process.env[name];
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export const processEnv = (): Record<string, string | undefined> => process.env;
