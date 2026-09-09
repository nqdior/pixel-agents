import * as fs from 'node:fs';
import * as path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { buildFurnitureCatalog } from '../../core/src/assets/build.js';
import { decodeAllFurniture } from '../../core/src/assets/loader.js';
import { createStudioLayout } from '../../scripts/studio-example.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { buildDynamicCatalog, getCatalogEntry } from '../src/office/layout/furnitureCatalog.js';
import {
  getBlockedTiles,
  layoutToSeats,
  layoutToTileMap,
} from '../src/office/layout/layoutSerializer.js';
import { findPath } from '../src/office/layout/tileMap.js';
import { TileType } from '../src/office/types.js';

beforeAll(() => {
  const root = path.resolve(__dirname, '../public/assets');
  const catalog = buildFurnitureCatalog(root);
  buildDynamicCatalog({ catalog, sprites: decodeAllFurniture(root, catalog) });
});

describe('public studio example', () => {
  it('ships a reproducible example and generic folder mappings', () => {
    const exampleRoot = path.resolve(__dirname, '../../examples/layouts');
    expect(JSON.parse(fs.readFileSync(path.join(exampleRoot, 'studio.json'), 'utf8'))).toEqual(
      createStudioLayout(),
    );
    const mappings = JSON.parse(
      fs.readFileSync(path.join(exampleRoot, 'folder-mappings.example.json'), 'utf8'),
    );
    expect(mappings).toEqual({ tools: ['WORK'], frontend: ['DESIGN'], backend: ['ENGINEERING'] });
    expect(createStudioLayout().pets).toEqual([]);
  });

  it('uses existing assets, a consistent grid and unique furniture identifiers', () => {
    const layout = createStudioLayout([{ id: 'existing-cat', petType: 0 }]);
    expect(layout.tiles).toHaveLength(layout.cols * layout.rows);
    expect(layout.tileColors).toHaveLength(layout.tiles.length);
    expect(layout.areaTiles).toHaveLength(layout.tiles.length);
    expect(layout.carpetTiles).toHaveLength(layout.tiles.length);
    expect(new Set(layout.furniture.map((item) => item.uid)).size).toBe(layout.furniture.length);
    expect(layout.pets).toEqual([{ id: 'existing-cat', petType: 0 }]);
    for (const item of layout.furniture) {
      const asset = getCatalogEntry(item.type);
      expect(asset, item.type).toBeDefined();
      expect(item.col + asset!.footprintW, item.uid).toBeLessThanOrEqual(layout.cols);
      expect(item.row + asset!.footprintH, item.uid).toBeLessThanOrEqual(layout.rows);
    }
  });

  it('has six reachable work seats in each project room and a connected lounge', () => {
    const layout = createStudioLayout();
    const seats = layoutToSeats(layout.furniture);
    const tileMap = layoutToTileMap(layout);
    const blocked = getBlockedTiles(layout.furniture);
    const byArea: Record<string, number> = {};
    for (const seat of seats.values()) {
      const area = layout.areaTiles![seat.seatRow * layout.cols + seat.seatCol]!;
      byArea[area] = (byArea[area] ?? 0) + 1;
      const allowed = new Set(blocked);
      allowed.delete(`${seat.seatCol},${seat.seatRow}`);
      expect(
        findPath(17, 26, seat.seatCol, seat.seatRow, tileMap, allowed).length,
        seat.uid,
      ).toBeGreaterThan(0);
      expect(tileMap[seat.seatRow][seat.seatCol]).not.toBe(TileType.WALL);
    }
    expect(byArea.WORK).toBe(6);
    expect(byArea.DESIGN).toBe(6);
    expect(byArea.ENGINEERING).toBe(6);
    expect(byArea.LOUNGE).toBeGreaterThanOrEqual(6);
  });

  it('seats new and existing sessions in their mapped rooms', () => {
    const office = new OfficeState(createStudioLayout());
    const mappings: Record<string, string[]> = {
      tools: ['WORK'],
      frontend: ['DESIGN'],
      backend: ['ENGINEERING'],
    };
    office.setAreaMappings(mappings);
    Object.keys(mappings).forEach((folder, index) => {
      office.addAgent(index + 1, 0, 0, undefined, true, folder);
    });
    office.rebuildFromLayout(createStudioLayout());
    for (const ch of office.characters.values()) {
      const seat = office.seats.get(ch.seatId!)!;
      const area =
        office.getLayout().areaTiles![seat.seatRow * office.getLayout().cols + seat.seatCol];
      expect(mappings[ch.folderName!]).toContain(area);
    }
  });

  it('supports local room names without changing the public defaults', () => {
    const rooms = { work: 'A', creative: 'B', lab: 'C', lounge: 'D' };
    const custom = createStudioLayout([], rooms);
    expect(custom.areas?.map((area) => area.label)).toEqual(Object.values(rooms));
    expect([...new Set(custom.areaTiles?.filter(Boolean))].sort()).toEqual(['A', 'B', 'C', 'D']);
    expect(createStudioLayout().areas?.map((area) => area.label)).toEqual([
      'WORK',
      'DESIGN',
      'ENGINEERING',
      'LOUNGE',
    ]);
  });
});
