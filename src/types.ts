/**
 * Core data structures for PropFlow
 */

export interface PropNode {
  componentName: string;
  filePath: string;
  propName: string;
  lineCode: number;
  type: "DEFINITION" | "USAGE" | "SOURCE";
  parent: PropNode | null;
  children?: PropNode[];
}

export interface PropReference {
  filePath: string;
  line: number;
  character: number;
  componentName: string;
}

export interface PropTrace {
  propName: string;
  chain: PropNode[];
  isComplete: boolean;
  ambiguous: boolean;
}

export interface ComponentInfo {
  name: string;
  filePath: string;
  props: string[];
  line: number;
}
