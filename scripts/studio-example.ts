import type { ColorValue } from '../webview-ui/src/components/ui/types.js';
import type { OfficeLayout, PlacedPet } from '../webview-ui/src/office/types.js';
import { TileType } from '../webview-ui/src/office/types.js';

export interface StudioRoomNames {
  work: string;
  creative: string;
  lab: string;
  lounge: string;
}

export const DEFAULT_STUDIO_ROOMS: StudioRoomNames = {
  work: 'WORK',
  creative: 'DESIGN',
  lab: 'ENGINEERING',
  lounge: 'LOUNGE',
};

export const STUDIO_PALETTE = {
  wall: { h: 210, s: 16, b: -65, c: -60 },
  work: { h: 33, s: 38, b: -22, c: -72 },
  creative: { h: 185, s: 28, b: -20, c: -72 },
  lab: { h: 140, s: 20, b: -18, c: -72 },
  lounge: { h: 28, s: 28, b: -12, c: -70 },
  corridor: { h: 38, s: 18, b: 4, c: -75 },
  rug: { h: 12, s: 36, b: -12, c: -50 },
  rugBorder: { h: 38, s: 40, b: 12, c: -60 },
} satisfies Record<string, ColorValue>;

export function createStudioLayout(
  pets: PlacedPet[] = [],
  rooms: StudioRoomNames = DEFAULT_STUDIO_ROOMS,
): OfficeLayout {
  const cols = 36;
  const rows = 28;
  const layout: OfficeLayout = {
    version: 1,
    cols,
    rows,
    layoutRevision: 1,
    tiles: Array(cols * rows).fill(TileType.WALL),
    tileColors: Array.from({ length: cols * rows }, () => ({ ...STUDIO_PALETTE.wall })),
    carpetTiles: Array(cols * rows).fill(null),
    areaTiles: Array(cols * rows).fill(null),
    furniture: [],
    pets: pets.map((pet) => ({ ...pet })),
    areas: [
      { label: rooms.work, color: '#d6a25a' },
      { label: rooms.creative, color: '#5bb5b0' },
      { label: rooms.lab, color: '#91b781' },
      { label: rooms.lounge, color: '#d89586' },
    ],
  };
  function floor(
    x: number,
    y: number,
    w: number,
    h: number,
    tile: TileType,
    color: ColorValue,
    area?: string,
  ): void {
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) {
        const index = row * cols + col;
        layout.tiles[index] = tile;
        layout.tileColors![index] = { ...color };
        layout.areaTiles![index] = area ?? null;
      }
    }
  }
  function item(uid: string, type: string, col: number, row: number, color?: ColorValue): void {
    layout.furniture.push({ uid: `studio-${uid}`, type, col, row, ...(color ? { color } : {}) });
  }
  function station(uid: string, col: number, row: number): void {
    item(`${uid}-desk`, 'DESK_FRONT', col, row);
    item(`${uid}-pc`, 'PC_FRONT_OFF', col + 1, row);
    item(`${uid}-seat`, 'CUSHIONED_BENCH', col + 1, row + 2);
  }
  function island(uid: string, col: number, row: number): void {
    item(`${uid}-table`, 'TABLE_FRONT', col, row);
    for (const [index, offset] of [0, 2].entries()) {
      item(`${uid}-left-${index}`, 'WOODEN_CHAIR_SIDE', col - 1, row + offset);
      item(`${uid}-right-${index}`, 'WOODEN_CHAIR_SIDE:left', col + 3, row + offset);
      item(`${uid}-pc-left-${index}`, 'PC_SIDE', col, row + offset);
      item(`${uid}-pc-right-${index}`, 'PC_SIDE:left', col + 2, row + offset);
    }
  }
  floor(1, 1, 15, 12, TileType.FLOOR_7, STUDIO_PALETTE.work, rooms.work);
  floor(20, 1, 15, 12, TileType.FLOOR_1, STUDIO_PALETTE.creative, rooms.creative);
  floor(1, 14, 15, 13, TileType.FLOOR_7, STUDIO_PALETTE.lounge, rooms.lounge);
  floor(20, 14, 15, 13, TileType.FLOOR_3, STUDIO_PALETTE.lab, rooms.lab);
  floor(17, 1, 2, 26, TileType.FLOOR_9, STUDIO_PALETTE.corridor);
  for (const y of [6, 20]) {
    floor(16, y, 1, 3, TileType.FLOOR_9, STUDIO_PALETTE.corridor);
    floor(19, y, 1, 3, TileType.FLOOR_9, STUDIO_PALETTE.corridor);
  }
  floor(7, 13, 2, 1, TileType.FLOOR_9, STUDIO_PALETTE.corridor);
  floor(26, 13, 2, 1, TileType.FLOOR_9, STUDIO_PALETTE.corridor);
  floor(17, 27, 2, 1, TileType.FLOOR_9, STUDIO_PALETTE.corridor);

  for (const [rowIndex, y] of [3, 8].entries()) {
    for (const [colIndex, x] of [2, 7, 12].entries()) station(`work-${rowIndex}-${colIndex}`, x, y);
  }
  item('work-books', 'DOUBLE_BOOKSHELF', 2, 0);
  item('work-clock', 'CLOCK', 8, 0);
  item('work-board', 'WHITEBOARD', 11, 0);
  item('work-green-1', 'HANGING_PLANT', 5, 0);
  item('work-green-2', 'PLANT_2', 14, 10);
  item('work-coffee', 'COFFEE', 2, 4);
  item('work-bin', 'BIN', 1, 11);

  station('creative-left', 21, 3);
  station('creative-right', 30, 3);
  island('creative-team', 25, 7);
  item('creative-library-1', 'DOUBLE_BOOKSHELF', 21, 0);
  item('creative-library-2', 'DOUBLE_BOOKSHELF', 23, 0);
  item('creative-picture', 'LARGE_PAINTING', 28, 0);
  item('creative-hanging', 'HANGING_PLANT', 32, 0);
  item('creative-plant', 'LARGE_PLANT', 32, 9);
  item('creative-cactus', 'CACTUS', 21, 10);
  item('creative-coffee', 'COFFEE', 30, 4);

  island('lab-team', 22, 17);
  station('lab-top', 29, 16);
  station('lab-bottom', 29, 22);
  item('lab-whiteboard', 'WHITEBOARD', 30, 13);
  item('lab-books', 'DOUBLE_BOOKSHELF', 21, 13);
  item('lab-clock', 'CLOCK', 24, 13);
  item('lab-plant', 'LARGE_PLANT', 32, 23);
  item('lab-bin', 'BIN', 20, 25);
  item('lab-coffee', 'COFFEE', 29, 23);

  for (let row = 18; row <= 24; row++) {
    for (let col = 4; col <= 12; col++) {
      layout.carpetTiles![row * cols + col] = {
        variant: 1,
        color: { ...STUDIO_PALETTE.rug },
        accentColor: { ...STUDIO_PALETTE.rugBorder },
        order: 1,
      };
    }
  }
  item('lounge-table', 'COFFEE_TABLE', 7, 20);
  item('lounge-sofa-top', 'SOFA_FRONT', 7, 18);
  item('lounge-sofa-bottom', 'SOFA_BACK', 7, 24);
  item('lounge-sofa-left', 'SOFA_SIDE', 4, 20);
  item('lounge-sofa-right', 'SOFA_SIDE:left', 11, 20);
  item('lounge-coffee', 'COFFEE', 7, 21);
  item('lounge-cafe-table', 'SMALL_TABLE_FRONT', 2, 16);
  item('lounge-cafe-coffee', 'COFFEE', 2, 17);
  item('lounge-books', 'DOUBLE_BOOKSHELF', 2, 13);
  item('lounge-art', 'LARGE_PAINTING', 11, 13);
  item('lounge-hanging', 'HANGING_PLANT', 14, 13);
  item('lounge-plant-1', 'LARGE_PLANT', 1, 22);
  item('lounge-plant-2', 'PLANT', 14, 23);
  item('lounge-pot', 'POT', 14, 17);
  return layout;
}
