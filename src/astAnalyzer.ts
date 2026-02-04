import {
  Project,
  SourceFile,
  SyntaxKind,
  FunctionDeclaration,
  ArrowFunction,
  VariableDeclaration,
} from "ts-morph";
import { ComponentInfo } from "./types";
import * as vscode from "vscode";

export class ASTAnalyzer {
  readonly project: Project;

  constructor(readonly outputChannel?: vscode.OutputChannel) {
    this.project = new Project({
      skipAddingFilesFromTsConfig: true,
    });
  }

  private log(message: string) {
    if (this.outputChannel) {
      this.outputChannel.appendLine(message);
    }
  }

  /**
   * Analyzes a file and extracts component information
   * @param filePath Path to the file
   * @param documentText Optional in-memory document text (for unsaved changes)
   */
  public analyzeFile(filePath: string, documentText?: string): ComponentInfo[] {
    let sourceFile = this.project.getSourceFile(filePath);

    if (documentText) {
      // Use in-memory content (for unsaved changes in VS Code)
      if (sourceFile) {
        // Update existing source file with new content
        sourceFile.replaceWithText(documentText);
      } else {
        // Create new source file with in-memory content
        sourceFile = this.project.createSourceFile(filePath, documentText, {
          overwrite: true,
        });
      }
    } else {
      // Use file system content
      if (sourceFile) {
        // Refresh from disk
        sourceFile.refreshFromFileSystemSync();
      } else {
        // Add from disk
        sourceFile = this.project.addSourceFileAtPath(filePath);
      }
    }

    const components: ComponentInfo[] = [];

    // Find function components
    sourceFile.getFunctions().forEach((func) => {
      const componentInfo = this.extractComponentFromFunction(func, filePath);
      if (componentInfo) {
        components.push(componentInfo);
      }
    });

    // Find arrow function components
    sourceFile.getVariableDeclarations().forEach((varDecl) => {
      const componentInfo = this.extractComponentFromVariable(
        varDecl,
        filePath,
      );
      if (componentInfo) {
        components.push(componentInfo);
      }
    });

    return components;
  }

  /**
   * Extracts props from a component's parameter
   */
  public extractPropsFromComponent(
    filePath: string,
    componentName: string,
  ): string[] {
    const sourceFile = this.project.getSourceFile(filePath);
    if (!sourceFile) return [];

    const props: string[] = [];

    // Check function declarations
    const func = sourceFile.getFunction(componentName);
    if (func) {
      const params = func.getParameters();
      if (params.length > 0) {
        props.push(...this.extractPropsFromParameter(params[0]));
      }
    }

    // Check variable declarations (arrow functions)
    const varDecl = sourceFile.getVariableDeclaration(componentName);
    if (varDecl) {
      const initializer = varDecl.getInitializer();
      if (
        initializer &&
        (initializer.getKind() === SyntaxKind.ArrowFunction ||
          initializer.getKind() === SyntaxKind.FunctionExpression)
      ) {
        const arrowFunc = initializer.asKindOrThrow(SyntaxKind.ArrowFunction);
        const params = arrowFunc.getParameters();
        if (params.length > 0) {
          props.push(...this.extractPropsFromParameter(params[0]));
        }
      }
    }

    // If no props found from parameters, try to find type definition
    if (props.length === 0) {
      const typeProps = this.extractPropsFromTypeDefinition(
        sourceFile,
        componentName,
      );
      props.push(...typeProps);
    }

    return props;
  }

  /**
   * Extracts props from TypeScript type/interface definitions
   */
  private extractPropsFromTypeDefinition(
    sourceFile: SourceFile,
    componentName: string,
  ): string[] {
    const props: string[] = [];

    // Look for type like: type ComponentNameProps = { ... }
    const typeName = `${componentName}Props`;

    // Check TypeAliasDeclaration
    const typeAlias = sourceFile.getTypeAlias(typeName);
    if (typeAlias) {
      const typeNode = typeAlias.getTypeNode();
      if (typeNode && typeNode.getKind() === SyntaxKind.TypeLiteral) {
        const members = typeNode
          .asKindOrThrow(SyntaxKind.TypeLiteral)
          .getMembers();
        members.forEach((member) => {
          if (member.getKind() === SyntaxKind.PropertySignature) {
            const propSig = member.asKindOrThrow(SyntaxKind.PropertySignature);
            const name = propSig.getName();
            if (name) {
              props.push(name);
            }
          }
        });
      }
    }

    // Check Interface
    const interfaceDecl = sourceFile.getInterface(typeName);
    if (interfaceDecl) {
      const properties = interfaceDecl.getProperties();
      properties.forEach((prop) => {
        const name = prop.getName();
        if (name) {
          props.push(name);
        }
      });
    }

    this.log(
      `  Found ${props.length} props from type definition ${typeName}: ${props.join(", ")}`,
    );

    return props;
  }

  /**
   * Finds where a prop is passed to a component at a specific location
   */
  public findPropUsageAtLocation(
    sourceFile: SourceFile,
    componentName: string,
    propName: string,
    nearLine: number,
  ): { line: number; value: string | null } | null {
    // Check both opening elements and self-closing elements
    const openingElements = sourceFile.getDescendantsOfKind(
      SyntaxKind.JsxOpeningElement,
    );
    const selfClosingElements = sourceFile.getDescendantsOfKind(
      SyntaxKind.JsxSelfClosingElement,
    );
    const allElements = [...openingElements, ...selfClosingElements];

    this.log(
      `  Searching for <${componentName} ${propName}=... /> near line ${nearLine}`,
    );
    this.log(
      `  Found ${openingElements.length} opening + ${selfClosingElements.length} self-closing = ${allElements.length} total JSX elements`,
    );

    // Log ALL tag names we find to debug the issue
    const allTagNames = new Set<string>();
    for (const element of allElements) {
      const tagName =
        element.getKind() === SyntaxKind.JsxOpeningElement
          ? element
              .asKindOrThrow(SyntaxKind.JsxOpeningElement)
              .getTagNameNode()
              .getText()
          : element
              .asKindOrThrow(SyntaxKind.JsxSelfClosingElement)
              .getTagNameNode()
              .getText();
      allTagNames.add(tagName);
    }
    this.log(`  All unique tag names: ${Array.from(allTagNames).join(", ")}`);

    // Find matching components
    const matchingComponents = [];
    for (const element of allElements) {
      const isOpening = element.getKind() === SyntaxKind.JsxOpeningElement;
      const tagName = isOpening
        ? element
            .asKindOrThrow(SyntaxKind.JsxOpeningElement)
            .getTagNameNode()
            .getText()
        : element
            .asKindOrThrow(SyntaxKind.JsxSelfClosingElement)
            .getTagNameNode()
            .getText();
      const elementLine = element.getStartLineNumber();

      if (tagName === componentName) {
        matchingComponents.push({ element, line: elementLine });
        this.log(
          `  Found <${componentName}${isOpening ? ">" : " />"}  at line ${elementLine}`,
        );
      }
    }

    if (matchingComponents.length === 0) {
      this.log(`  No <${componentName}> elements found!`);
      return null;
    }

    // Find the closest one
    let closestMatch = matchingComponents[0];
    let closestDistance = Math.abs(closestMatch.line - nearLine);

    for (const match of matchingComponents) {
      const distance = Math.abs(match.line - nearLine);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestMatch = match;
      }
    }

    this.log(
      `  Using element at line ${closestMatch.line} (distance: ${closestDistance})`,
    );

    // Get attributes from either opening or self-closing element
    const element = closestMatch.element;
    let attributes;
    let hasSpread = false;

    if (element.getKind() === SyntaxKind.JsxOpeningElement) {
      const openingEl = element.asKindOrThrow(SyntaxKind.JsxOpeningElement);
      attributes = openingEl.getAttributes();
      hasSpread = attributes.some(
        (attr) => attr.getKind() === SyntaxKind.JsxSpreadAttribute,
      );
    } else {
      const selfClosingEl = element.asKindOrThrow(
        SyntaxKind.JsxSelfClosingElement,
      );
      attributes = selfClosingEl.getAttributes();
      hasSpread = attributes.some(
        (attr) => attr.getKind() === SyntaxKind.JsxSpreadAttribute,
      );
    }

    this.log(
      `    Found ${attributes.length} attributes, Has spread: ${hasSpread}`,
    );

    for (const attr of attributes) {
      if (attr.getKind() === SyntaxKind.JsxAttribute) {
        const jsxAttr = attr.asKindOrThrow(SyntaxKind.JsxAttribute);
        const attrName = jsxAttr.getNameNode().getText();

        this.log(`    Attribute: ${attrName}`);

        if (attrName === propName) {
          const initializer = jsxAttr.getInitializer();
          const line = jsxAttr.getStartLineNumber();

          this.log(`    ✓✓ MATCHED prop "${propName}" at line ${line}`);

          if (!initializer) {
            this.log(`    Value: true (boolean)`);
            return { line, value: "true" };
          }

          if (initializer.getKind() === SyntaxKind.StringLiteral) {
            const value = initializer.getText();
            this.log(`    Value: ${value} (string literal)`);
            return { line, value };
          }

          if (initializer.getKind() === SyntaxKind.JsxExpression) {
            const expr = initializer.asKindOrThrow(SyntaxKind.JsxExpression);
            const expression = expr.getExpression();
            const value = expression ? expression.getText() : null;
            this.log(`    Value: ${value} (expression)`);
            return { line, value };
          }
        }
      }
    }

    if (hasSpread) {
      this.log(`    Found spread operator, marking as ambiguous`);
      return { line: closestMatch.line, value: "{...spread}" };
    }

    this.log(`  No prop "${propName}" found in attributes`);
    return null;
  }

  /**
   * Finds where a prop is passed to a component (searches entire file)
   */
  public findPropUsage(
    sourceFile: SourceFile,
    componentName: string,
    propName: string,
  ): { line: number; value: string | null } | null {
    const jsxElements = sourceFile.getDescendantsOfKind(
      SyntaxKind.JsxOpeningElement,
    );

    this.log(`  Searching for <${componentName} ${propName}=... />`);
    this.log(`  Found ${jsxElements.length} JSX elements in file`);

    for (const element of jsxElements) {
      const tagName = element.getTagNameNode().getText();

      if (tagName === componentName) {
        this.log(`  ✓ Found matching component: <${componentName}>`);
        const attributes = element.getAttributes();

        // Check for spread attributes
        const hasSpread = attributes.some(
          (attr) => attr.getKind() === SyntaxKind.JsxSpreadAttribute,
        );

        this.log(
          `    Attributes: ${attributes.length}, Has spread: ${hasSpread}`,
        );

        for (const attr of attributes) {
          if (attr.getKind() === SyntaxKind.JsxAttribute) {
            const jsxAttr = attr.asKindOrThrow(SyntaxKind.JsxAttribute);
            const attrName = jsxAttr.getNameNode().getText();

            this.log(`    Attribute: ${attrName}`);

            if (attrName === propName) {
              const initializer = jsxAttr.getInitializer();
              const line = jsxAttr.getStartLineNumber();

              this.log(`    ✓✓ MATCHED prop "${propName}" at line ${line}`);

              if (!initializer) {
                // Boolean prop like <Component show />
                this.log(`    Value: true (boolean)`);
                return { line, value: "true" };
              }

              if (initializer.getKind() === SyntaxKind.StringLiteral) {
                const value = initializer.getText();
                this.log(`    Value: ${value} (string literal)`);
                return { line, value };
              }

              if (initializer.getKind() === SyntaxKind.JsxExpression) {
                const expr = initializer.asKindOrThrow(
                  SyntaxKind.JsxExpression,
                );
                const expression = expr.getExpression();
                const value = expression ? expression.getText() : null;
                this.log(`    Value: ${value} (expression)`);
                return { line, value };
              }
            }
          }
        }

        // If we have a spread and didn't find explicit prop, it might be in the spread
        if (hasSpread) {
          this.log(`    Found spread operator, marking as ambiguous`);
          return { line: element.getStartLineNumber(), value: "{...spread}" };
        }
      }
    }

    this.log(`  No prop usage found for ${propName} in ${componentName}`);
    return null;
  }

  private extractComponentFromFunction(
    func: FunctionDeclaration,
    filePath: string,
  ): ComponentInfo | null {
    const name = func.getName();
    if (!name) return null;

    // Check if it's likely a React component (starts with uppercase)
    if (!/^[A-Z]/.test(name)) return null;

    const params = func.getParameters();
    let props =
      params.length > 0 ? this.extractPropsFromParameter(params[0]) : [];

    // If no props from parameters, check for type definition
    if (props.length === 0) {
      const sourceFile = func.getSourceFile();
      props = this.extractPropsFromTypeDefinition(sourceFile, name);
    }

    // Get the line number of the function keyword, not the export keyword
    // by using the function keyword's position
    let line = func.getStartLineNumber();
    const functionKeyword = func.getFirstChildByKind(
      SyntaxKind.FunctionKeyword,
    );
    if (functionKeyword) {
      line = functionKeyword.getStartLineNumber();
    }

    return {
      name,
      filePath,
      props,
      line,
    };
  }

  private extractComponentFromVariable(
    varDecl: VariableDeclaration,
    filePath: string,
  ): ComponentInfo | null {
    const name = varDecl.getName();
    if (!/^[A-Z]/.test(name)) return null;

    const initializer = varDecl.getInitializer();
    if (!initializer) return null;

    const kind = initializer.getKind();
    if (
      kind !== SyntaxKind.ArrowFunction &&
      kind !== SyntaxKind.FunctionExpression
    ) {
      return null;
    }

    const funcExpr = initializer as ArrowFunction;
    const params = funcExpr.getParameters();
    let props =
      params.length > 0 ? this.extractPropsFromParameter(params[0]) : [];

    // If no props from parameters, check for type definition
    if (props.length === 0) {
      const sourceFile = varDecl.getSourceFile();
      props = this.extractPropsFromTypeDefinition(sourceFile, name);
    }

    // Get the line of the variable declaration (const ComponentName = ...)
    // This should be the line where 'const' keyword appears
    const varStatement = varDecl.getVariableStatement();
    let line = varDecl.getStartLineNumber();

    // If there's a variable statement (const/let/var), use its line
    if (varStatement) {
      line = varStatement.getStartLineNumber();
    }

    return {
      name,
      filePath,
      props,
      line,
    };
  }

  private extractPropsFromParameter(param: any): string[] {
    const props: string[] = [];

    // Handle destructured props: function Component({ name, age })
    if (param.getKind() === SyntaxKind.Parameter) {
      const nameNode = param.getNameNode();

      if (nameNode.getKind() === SyntaxKind.ObjectBindingPattern) {
        const elements = nameNode.getElements();
        elements.forEach((element: any) => {
          const propName = element.getName();
          if (propName) {
            props.push(propName);
          }
        });
      } else {
        // Handle non-destructured: function Component(props)
        const paramName = param.getName();
        if (paramName === "props") {
          // We'd need type information to extract individual props
          // For now, we'll just note that props exist
        }
      }
    }

    return props;
  }

  public getSourceFile(filePath: string): SourceFile | undefined {
    let sourceFile = this.project.getSourceFile(filePath);
    if (!sourceFile) {
      sourceFile = this.project.addSourceFileAtPath(filePath);
    }
    return sourceFile;
  }

  public dispose() {
    // Clean up project resources
  }
}
