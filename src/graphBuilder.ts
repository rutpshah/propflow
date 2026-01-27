import * as vscode from "vscode";
import { PropNode, PropTrace } from "./types";
import { ASTAnalyzer } from "./astAnalyzer";
import * as path from "path";

export class GraphBuilder {
  private analyzer: ASTAnalyzer;
  private maxDepth = 20; // Prevent infinite loops

  constructor(private outputChannel?: vscode.OutputChannel) {
    this.analyzer = new ASTAnalyzer(outputChannel);
  }

  private log(message: string) {
    if (this.outputChannel) {
      this.outputChannel.appendLine(message);
    }
  }

  /**
   * Builds the propflow lineage chain from a given component and prop
   */
  public async buildPropChain(
    filePath: string,
    componentName: string,
    propName: string,
  ): Promise<PropTrace> {
    const chain: PropNode[] = [];

    // Get the line number for the current component
    const components = this.analyzer.analyzeFile(filePath);
    const currentComponent = components.find((c) => c.name === componentName);
    const lineCode = currentComponent ? currentComponent.line : 0;

    let currentNode: PropNode = {
      componentName,
      filePath,
      propName,
      lineCode,
      type: "DEFINITION",
      parent: null,
    };

    chain.push(currentNode);
    let depth = 0;
    let isComplete = true;
    let ambiguous = false;

    while (depth < this.maxDepth) {
      depth++;

      const parentNode = await this.findParentNode(currentNode);

      if (!parentNode) {
        // Reached the source - mark the last node in chain as SOURCE
        if (chain.length > 0) {
          chain[chain.length - 1].type = "SOURCE";
        }
        break;
      }

      if (parentNode.propName === "{...spread}") {
        ambiguous = true;
      }

      chain.push(parentNode);
      currentNode.parent = parentNode;
      currentNode = parentNode;
    }

    if (depth >= this.maxDepth) {
      isComplete = false;
    }

    // Reverse to show from source to current (top to bottom)
    const reversedChain = chain.reverse();

    // Mark the first item as SOURCE and last as DEFINITION
    if (reversedChain.length > 0) {
      reversedChain[0].type = "SOURCE";
      if (reversedChain.length > 1) {
        reversedChain[reversedChain.length - 1].type = "DEFINITION";
        // Middle items are USAGE
        for (let i = 1; i < reversedChain.length - 1; i++) {
          reversedChain[i].type = "USAGE";
        }
      }
    }

    return {
      propName,
      chain: reversedChain,
      isComplete,
      ambiguous,
    };
  }

  /**
   * Finds the parent component that passes the prop
   */
  private async findParentNode(node: PropNode): Promise<PropNode | null> {
    try {
      this.log(
        `\nLooking for parent of ${node.componentName} with prop ${node.propName}`,
      );

      // Search workspace for JSX usages of this component
      const usages = await this.findComponentUsagesInWorkspace(
        node.componentName,
      );

      this.log(`Found ${usages.length} usages of ${node.componentName}`);

      if (usages.length === 0) {
        return null;
      }

      // Analyze each usage to see if it passes our prop
      for (const location of usages) {
        const refFilePath = location.uri.fsPath;

        // Skip if it's the same file as the component definition
        if (refFilePath === node.filePath) {
          this.log(`Skipping same file: ${refFilePath}`);
          continue;
        }

        this.log(
          `Analyzing usage in: ${refFilePath} at line ${location.range.start.line + 1}`,
        );

        const parentNode = await this.analyzeLocationForPropUsage(
          location,
          node,
        );
        if (parentNode) {
          this.log(
            `✓ Found parent: ${parentNode.componentName} passes prop as ${parentNode.propName}`,
          );
          return parentNode;
        }
      }

      this.log(`No parent found for ${node.componentName}`);
      return null;
    } catch (error) {
      this.log(`Error finding parent node: ${error}`);
      return null;
    }
  }

  /**
   * Find component usages across the workspace using text search
   */
  private async findComponentUsagesInWorkspace(
    componentName: string,
  ): Promise<vscode.Location[]> {
    const locations: vscode.Location[] = [];

    try {
      // Search for all TypeScript/JavaScript React files
      const files = await vscode.workspace.findFiles(
        "**/*.{tsx,jsx,ts,js}",
        "**/node_modules/**",
        200,
      );

      for (const file of files) {
        try {
          const document = await vscode.workspace.openTextDocument(file);
          const text = document.getText();

          // Look for JSX usage: <ComponentName (with word boundary)
          const jsxRegex = new RegExp(`<${componentName}[\\s\\/>]`, "g");
          let match;

          while ((match = jsxRegex.exec(text)) !== null) {
            const pos = document.positionAt(match.index);
            this.log(
              `  Found JSX usage <${componentName}> in ${file.fsPath.split("/").pop()} at line ${pos.line + 1}`,
            );
            locations.push(new vscode.Location(file, pos));
          }
        } catch (err) {
          // Skip files that can't be read
          continue;
        }
      }
    } catch (error) {
      this.log(`Workspace search error: ${error}`);
    }

    return locations;
  }

  /**
   * Analyze a specific location to see if it contains prop usage
   */
  private async analyzeLocationForPropUsage(
    location: vscode.Location,
    node: PropNode,
  ): Promise<PropNode | null> {
    const refFilePath = location.uri.fsPath;

    try {
      const sourceFile = this.analyzer.getSourceFile(refFilePath);
      if (!sourceFile) {
        this.log(`  Could not get source file for ${refFilePath}`);
        return null;
      }

      // Find the exact JSX element at this location
      const propUsage = this.analyzer.findPropUsageAtLocation(
        sourceFile,
        node.componentName,
        node.propName,
        location.range.start.line + 1, // Convert 0-based to 1-based line number
      );

      if (!propUsage) {
        this.log(`  No prop usage found for ${node.propName}`);
        return null;
      }

      this.log(
        `  Found prop usage: ${node.propName} = ${propUsage.value} at line ${propUsage.line}`,
      );

      // Find which component contains this JSX usage
      const parentComponent = this.findComponentAtLine(
        refFilePath,
        propUsage.line,
      );

      if (!parentComponent) {
        this.log(`  Could not find parent component at line ${propUsage.line}`);
        return null;
      }

      this.log(`  Parent component: ${parentComponent.name}`);

      // Extract the actual prop name/value being passed
      const extractedPropName = this.extractPropName(propUsage.value);
      const nodeType = this.determineNodeType(propUsage.value);

      const parentNode: PropNode = {
        componentName: parentComponent.name,
        filePath: refFilePath,
        propName: extractedPropName,
        lineCode: propUsage.line,
        type: nodeType,
        parent: null,
      };

      // If this is a SOURCE (literal value), stop tracing here
      if (nodeType === "SOURCE") {
        this.log(`  This is a source value, stopping trace`);
      }

      return parentNode;
    } catch (error) {
      this.log(`  Error analyzing location: ${error}`);
      return null;
    }
  }

  /**
   * Finds which component exists at a given line in a file
   */
  private findComponentAtLine(
    filePath: string,
    line: number,
  ): { name: string } | null {
    const components = this.analyzer.analyzeFile(filePath);

    // Find the component that contains this line
    // Simple heuristic: find the closest component before this line
    let closestComponent: { name: string; line: number } | null = null;

    for (const comp of components) {
      if (comp.line <= line) {
        if (!closestComponent || comp.line > closestComponent.line) {
          closestComponent = { name: comp.name, line: comp.line };
        }
      }
    }

    return closestComponent;
  }

  /**
   * Extracts the prop name from a prop value
   */
  private extractPropName(value: string | null): string {
    if (!value) return "unknown";

    // Handle spread
    if (value === "{...spread}") return "{...spread}";

    // Handle simple identifiers: {userName} -> userName
    const match = value.match(/^{?\s*(\w+)\s*}?$/);
    if (match) return match[1];

    // Handle props access: {props.name} -> name
    const propsMatch = value.match(/props\.(\w+)/);
    if (propsMatch) return propsMatch[1];

    return value;
  }

  /**
   * Determines the type of node based on the value
   */
  private determineNodeType(
    value: string | null,
  ): "DEFINITION" | "USAGE" | "SOURCE" {
    if (!value) return "SOURCE";

    // Literal values are sources (strings, numbers, booleans)
    if (
      value.startsWith('"') ||
      value.startsWith("'") ||
      value === "true" ||
      value === "false" ||
      /^\d+$/.test(value)
    ) {
      return "SOURCE";
    }

    // Props passthrough
    if (value.includes("props.")) {
      return "USAGE";
    }

    // Variables could be either - default to usage
    return "USAGE";
  }

  public dispose() {
    this.analyzer.dispose();
  }
}
