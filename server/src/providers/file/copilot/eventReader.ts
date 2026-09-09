import { StringDecoder } from 'node:string_decoder';

import {
  EVENT_FIELDS,
  MAX_JSON_DEPTH,
  MAX_SCALAR_LENGTH,
  NUMERIC_FIELDS,
  PREVIEW_CHAR_LIMIT,
  PREVIEW_FIELDS,
} from './constants.js';

export type ProjectedEvent = Record<string, string | boolean>;

interface Frame {
  kind: 'object' | 'array';
  state: 'keyOrEnd' | 'key' | 'colon' | 'valueOrEnd' | 'value' | 'commaOrEnd';
  path: string;
  key: string;
}

/**
 * Incremental JSONL projection, not a line buffer. Only bounded message previews
 * and allowlisted tool metadata are retained; model snapshots and results are not. Memory is
 * bounded by nesting/scalar limits, not by the size of a transcript or line.
 * Only complete, valid records are delivered; UTF-8 and JSON tokens may span scans.
 */
export class EventReader {
  private decoder = new StringDecoder('utf8');
  private frames: Frame[] = [];
  private fields: ProjectedEvent = {};
  private mode: 'idle' | 'string' | 'atom' = 'idle';
  private token = '';
  private tokenPath = '';
  private tokenIsKey = false;
  private capture = false;
  private overflow = false;
  private escaped = false;
  private unicodeRemaining = 0;
  private nonempty = false;
  private rootDone = false;
  private invalid = false;
  private hasData = false;
  private safeTokenLength = 0;

  constructor(
    private readonly onEvent: (event: ProjectedEvent) => void,
    private readonly onMalformed: () => void,
  ) {}

  push(bytes: Buffer): void {
    const text = this.decoder.write(bytes);
    for (const char of text) {
      if (char === '\n') {
        if (this.mode === 'atom') this.endAtom();
        if (this.hasData) {
          if (this.invalid || !this.rootDone || this.frames.length || this.mode !== 'idle') {
            this.onMalformed();
          } else {
            this.onEvent(this.fields);
          }
        }
        this.resetLine();
      } else {
        this.consume(char);
      }
    }
  }

  private resetLine(): void {
    this.frames = [];
    this.fields = {};
    this.mode = 'idle';
    this.token = '';
    this.invalid = false;
    this.rootDone = false;
    this.hasData = false;
  }

  private valuePath(): string {
    const frame = this.frames.at(-1);
    if (!frame) return '';
    if (frame.kind === 'array') {
      return frame.path === 'data.arguments.paths' ? frame.path : '*';
    }
    if (!frame.path && frame.key === '') return '*';
    return frame.path === '*' ? '*' : frame.path ? `${frame.path}.${frame.key}` : frame.key;
  }

  private beginValue(): string {
    const frame = this.frames.at(-1);
    if (frame) {
      if (frame.state !== 'value' && frame.state !== 'valueOrEnd') {
        this.invalid = true;
      }
      if (frame.kind === 'array' && frame.path === 'data.toolRequests') {
        this.fields['data.toolRequests'] = true;
      }
      frame.state = 'commaOrEnd';
    } else if (this.rootDone) {
      this.invalid = true;
    } else {
      this.rootDone = true;
    }
    return this.valuePath();
  }

  private consume(char: string): void {
    if (this.invalid) return;
    if (this.mode === 'string') {
      this.stringChar(char);
      return;
    }
    if (this.mode === 'atom') {
      if (!/[\s,\]}]/.test(char)) {
        this.appendToken(char);
        return;
      }
      this.endAtom();
      if (this.invalid) return;
    }
    if (char === ' ' || char === '\t' || char === '\r') return;
    this.hasData = true;
    const frame = this.frames.at(-1);
    if (char === '"') {
      this.tokenIsKey =
        !!frame && frame.kind === 'object' && (frame.state === 'key' || frame.state === 'keyOrEnd');
      this.tokenPath = this.tokenIsKey ? '' : this.beginValue();
      this.capture =
        this.tokenIsKey || EVENT_FIELDS.has(this.tokenPath) || PREVIEW_FIELDS.has(this.tokenPath);
      this.mode = 'string';
      this.token = '';
      this.overflow = false;
      this.escaped = false;
      this.unicodeRemaining = 0;
      this.nonempty = false;
      this.safeTokenLength = 0;
    } else if (char === '{' || char === '[') {
      const valuePath = this.beginValue();
      if (valuePath === 'data.toolRequests' && char === '[') {
        this.fields[valuePath] = false;
      }
      if (this.frames.length >= MAX_JSON_DEPTH) {
        this.invalid = true;
        return;
      }
      this.frames.push({
        kind: char === '{' ? 'object' : 'array',
        state: char === '{' ? 'keyOrEnd' : 'valueOrEnd',
        path: valuePath,
        key: '',
      });
    } else if (char === '}' || char === ']') {
      if (
        !frame ||
        frame.kind !== (char === '}' ? 'object' : 'array') ||
        !['keyOrEnd', 'valueOrEnd', 'commaOrEnd'].includes(frame.state)
      ) {
        this.invalid = true;
      } else {
        this.frames.pop();
      }
    } else if (char === ':') {
      if (frame?.state !== 'colon') this.invalid = true;
      else frame.state = 'value';
    } else if (char === ',') {
      if (frame?.state !== 'commaOrEnd') this.invalid = true;
      else frame.state = frame.kind === 'object' ? 'key' : 'value';
    } else {
      this.tokenPath = this.beginValue();
      this.mode = 'atom';
      this.token = char;
      this.capture = true;
      this.overflow = false;
    }
  }

  private appendToken(char: string): void {
    if (!this.capture || this.overflow) return;
    if (this.token.length >= MAX_SCALAR_LENGTH) {
      this.overflow = true;
      if (!PREVIEW_FIELDS.has(this.tokenPath)) this.token = '';
    } else {
      this.token += char;
    }
  }

  private stringChar(char: string): void {
    if (this.unicodeRemaining) {
      if (!/^[\da-f]$/i.test(char)) this.invalid = true;
      this.unicodeRemaining--;
    } else if (this.escaped) {
      if (char === 'u') this.unicodeRemaining = 4;
      else if (!'"\\/bfnrt'.includes(char)) this.invalid = true;
      this.escaped = false;
    } else if (char === '\\') {
      this.escaped = true;
    } else if (char === '"') {
      if (this.tokenIsKey) {
        const frame = this.frames.at(-1)!;
        frame.key = this.overflow ? '*' : (JSON.parse(`"${this.token}"`) as string);
        frame.state = 'colon';
      } else if (PREVIEW_FIELDS.has(this.tokenPath)) {
        const decoded = JSON.parse(`"${this.token.slice(0, this.safeTokenLength)}"`) as string;
        const preview = decoded.slice(0, PREVIEW_CHAR_LIMIT).replace(/[\uD800-\uDBFF]$/, '');
        const target = this.tokenPath === 'data.content' ? 'data.content.preview' : this.tokenPath;
        const previous = target === 'data.arguments.paths' ? this.fields[target] : undefined;
        const combined = typeof previous === 'string' ? `${previous}, ${preview}` : preview;
        this.fields[target] = combined.slice(0, PREVIEW_CHAR_LIMIT);
        this.fields[`${target}.truncated`] =
          this.fields[`${target}.truncated`] === true ||
          this.overflow ||
          decoded.length > preview.length ||
          combined.length > PREVIEW_CHAR_LIMIT;
        if (this.tokenPath === 'data.content') this.fields[this.tokenPath] = this.nonempty;
      } else if (this.capture && !this.overflow) {
        this.fields[this.tokenPath] = JSON.parse(`"${this.token}"`) as string;
      } else if (this.tokenPath === 'data.content') {
        this.fields[this.tokenPath] = this.nonempty;
      }
      this.mode = 'idle';
      this.token = '';
      return;
    } else if (char.charCodeAt(0) < 0x20) {
      this.invalid = true;
    }
    this.nonempty = true;
    this.appendToken(char);
    if (!this.overflow && !this.escaped && this.unicodeRemaining === 0)
      this.safeTokenLength = this.token.length;
  }

  private endAtom(): void {
    if (
      this.overflow ||
      !/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(this.token)
    ) {
      this.invalid = true;
    } else if (EVENT_FIELDS.has(this.tokenPath) || NUMERIC_FIELDS.has(this.tokenPath)) {
      // Event identifiers must be strings; only numeric timestamps are accepted.
      if (
        (this.tokenPath === 'timestamp' || NUMERIC_FIELDS.has(this.tokenPath)) &&
        /^-?\d/.test(this.token)
      ) {
        this.fields[this.tokenPath] = this.token;
      } else if (this.tokenPath === 'data.success' && /^(true|false)$/.test(this.token)) {
        this.fields[this.tokenPath] = this.token === 'true';
      }
    }
    this.mode = 'idle';
    this.token = '';
  }
}
