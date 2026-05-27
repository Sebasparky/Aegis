import type { TracePurpose } from "./types";

export type TaskKind =
  | "click"
  | "input_focus"
  | "dropdown"
  | "drag"
  | "scroll"
  | "scroll_then_click"
  | "movement"
  | "correction"
  | "visual_search";

export type MovementDir = "ltr" | "rtl" | "ttb" | "btt" | "diag_ur" | "diag_dl";

export interface CalibrationTask {
  id: string;
  label: string;
  detail?: string;
  purpose: TracePurpose;
  kind: TaskKind;
  targetSize?: { w: number; h: number };
  movementDir?: MovementDir;
  sliderTarget?: number;
  scrollThreshold?: number;
  edgePosition?: "top_right" | "bottom_left";
}

export const CALIBRATION_TASKS: CalibrationTask[] = [
  {
    id: "large_btn",
    label: "Click the large button",
    detail: "Move your cursor to the button and click it naturally.",
    purpose: "button_click",
    kind: "click",
    targetSize: { w: 120, h: 48 },
  },
  {
    id: "small_btn",
    label: "Click the small button",
    detail: "The target is smaller — take your time.",
    purpose: "button_click",
    kind: "click",
    targetSize: { w: 64, h: 32 },
  },
  {
    id: "input_focus",
    label: "Click to focus the text input",
    detail: "Click inside the input field as if you were about to type.",
    purpose: "input_focus",
    kind: "input_focus",
  },
  {
    id: "dropdown",
    label: "Click to open the dropdown",
    detail: "Click the dropdown to open it. No need to select an option.",
    purpose: "dropdown",
    kind: "dropdown",
  },
  {
    id: "h_ltr",
    label: "Move cursor: Left → Right",
    detail: "Start from the left zone and move your cursor to the right zone.",
    purpose: "long_move",
    kind: "movement",
    movementDir: "ltr",
  },
  {
    id: "h_rtl",
    label: "Move cursor: Right → Left",
    detail: "Start from the right zone and move your cursor to the left zone.",
    purpose: "long_move",
    kind: "movement",
    movementDir: "rtl",
  },
  {
    id: "v_ttb",
    label: "Move cursor: Top → Bottom",
    detail: "Start from the top zone and move your cursor to the bottom zone.",
    purpose: "long_move",
    kind: "movement",
    movementDir: "ttb",
  },
  {
    id: "v_btt",
    label: "Move cursor: Bottom → Top",
    detail: "Start from the bottom zone and move your cursor to the top zone.",
    purpose: "long_move",
    kind: "movement",
    movementDir: "btt",
  },
  {
    id: "diag_ur",
    label: "Move cursor: Diagonal → Upper Right",
    detail: "Start from the lower-left target and move diagonally to the upper-right target.",
    purpose: "long_move",
    kind: "movement",
    movementDir: "diag_ur",
  },
  {
    id: "diag_dl",
    label: "Move cursor: Diagonal → Lower Left",
    detail: "Start from the upper-right target and move diagonally to the lower-left target.",
    purpose: "long_move",
    kind: "movement",
    movementDir: "diag_dl",
  },
  {
    id: "correction",
    label: "Click the off-center target",
    detail: "The button is shifted inside its container — find it and click it.",
    purpose: "correction",
    kind: "correction",
  },
  {
    id: "drag_slider",
    label: "Drag the slider to the 75% mark",
    detail: "Press and hold, then drag to reach the marker. Release when done.",
    purpose: "drag",
    kind: "drag",
    sliderTarget: 75,
  },
  {
    id: "scroll_panel",
    label: "Scroll the panel to the bottom",
    detail: "Use your scroll wheel or trackpad to scroll the content area all the way down.",
    purpose: "scroll",
    kind: "scroll",
    scrollThreshold: 200,
  },
  {
    id: "scroll_click",
    label: "Scroll to reveal then click the hidden button",
    detail: "Scroll down inside the panel to reveal the button, then click it.",
    purpose: "button_click",
    kind: "scroll_then_click",
  },
  {
    id: "edge_click",
    label: "Click the button near the top-right corner",
    detail: "The button is positioned close to the viewport edge.",
    purpose: "button_click",
    kind: "click",
    edgePosition: "top_right",
    targetSize: { w: 96, h: 36 },
  },
  {
    id: "visual_search",
    label: "Find and click the highlighted button",
    detail: "One button in the grid is highlighted. Scan and click it.",
    purpose: "button_click",
    kind: "visual_search",
  },
  {
    id: "off_center",
    label: "Click the button (it is not centered in its box)",
    detail: "The clickable element is offset inside a larger container — look carefully.",
    purpose: "correction",
    kind: "correction",
  },
];
