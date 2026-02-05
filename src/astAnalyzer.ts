import {
  Project,
  SourceFile,
  SyntaxKind,
  FunctionDeclaration,
  ArrowFunction,
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

    // Find re-exported components (e.g., export { Button } from './Button')
    const reExports = this.findReExportedComponents(sourceFile, filePath);
    components.push(...reExports);

    return components;
  }

  /**
   * Finds re-exported components in a file
   * Handles: export { Component } from './path'
   *          export { Component as AliasedComponent } from './path'
   *          export * from './path'
   */
  private findReExportedComponents(
    sourceFile: SourceFile,
    filePath: string,
  ): ComponentInfo[] {
    const components: ComponentInfo[] = [];

    // Get all export declarations
    const exportDeclarations = sourceFile.getExportDeclarations();

    for (const exportDecl of exportDeclarations) {
      const moduleSpecifier = exportDecl.getModuleSpecifierValue();
      if (!moduleSpecifier) continue;

      // Resolve the module path
      const resolvedPath = this.resolveModulePath(filePath, moduleSpecifier);
      if (!resolvedPath) continue;

      // Check if it's a named export or export *
      const namedExports = exportDecl.getNamedExports();

      if (namedExports.length > 0) {
        // Named exports: export { Button, Card } from './components'
        for (const namedExport of namedExports) {
          const exportedName =
            namedExport.getAliasNode()?.getText() || namedExport.getName();
          const originalName = namedExport.getName();

          // Only process if it looks like a component (starts with uppercase)
          if (!/^[A-Z]/.test(exportedName)) continue;

          // Try to get props from the original module
          try {
            const originalSourceFile = this.getSourceFile(resolvedPath);
            if (originalSourceFile) {
              const originalComponents = this.analyzeFile(resolvedPath);
              const originalComponent = originalComponents.find(
                (c) => c.name === originalName,
              );

              if (originalComponent) {
                components.push({
                  name: exportedName,
                  filePath: filePath, // Use current file as the reference
                  props: originalComponent.props,
                  line: exportDecl.getStartLineNumber(),
                });
              }
            }
          } catch (error) {
            this.log(
              `  Could not resolve re-export: ${originalName} from ${moduleSpecifier}`,
            );
          }
        }
      } else if (exportDecl.isNamespaceExport()) {
        // export * from './components' - we can't easily know what's exported
        // This would require analyzing the target module
        this.log(
          `  Found namespace re-export from ${moduleSpecifier} (not fully traced)`,
        );
      }
    }

    return components;
  }

  /**
   * Resolves a relative module path to an absolute path
   */
  private resolveModulePath(
    currentFilePath: string,
    moduleSpecifier: string,
  ): string | null {
    // Only handle relative imports for now
    if (!moduleSpecifier.startsWith(".")) {
      return null;
    }

    const path = require("path");
    const fs = require("fs");
    const currentDir = path.dirname(currentFilePath);
    let resolvedPath = path.resolve(currentDir, moduleSpecifier);

    // Try common extensions
    const extensions = [".tsx", ".ts", ".jsx", ".js"];

    // Check if path already has extension
    if (extensions.some((ext) => resolvedPath.endsWith(ext))) {
      return fs.existsSync(resolvedPath) ? resolvedPath : null;
    }

    // Try adding extensions
    for (const ext of extensions) {
      const pathWithExt = resolvedPath + ext;
      if (fs.existsSync(pathWithExt)) {
        return pathWithExt;
      }
    }

    // Try index files
    for (const ext of extensions) {
      const indexPath = path.join(resolvedPath, `index${ext}`);
      if (fs.existsSync(indexPath)) {
        return indexPath;
      }
    }

    return null;
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
        // Both ArrowFunction and FunctionExpression have getParameters() method
        const funcExpr = initializer as ArrowFunction;
        const params = funcExpr.getParameters();
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

  private extractPropsFromParameter(param: any): string[] {
    const props: string[] = [];

    if (param.getKind() !== SyntaxKind.Parameter) {
      return props;
    }

    const nameNode = param.getNameNode();

    // CASE 1: Destructured props (with or without type annotation)
    // Example: ({ label, onPress }) or ({ label }: Props)
    if (nameNode && nameNode.getKind() === SyntaxKind.ObjectBindingPattern) {
      const elements = nameNode.getElements();
      elements.forEach((element: any) => {
        const propName = element.getName();
        if (propName) {
          props.push(propName);
        }
      });

      // Successfully extracted from destructuring
      if (props.length > 0) {
        return props;
      }
    }

    // CASE 2: Non-destructured parameter with type annotation
    const typeNode = param.getTypeNode();
    if (typeNode) {
      // CASE 2a: Inline type literal
      if (typeNode.getKind() === SyntaxKind.TypeLiteral) {
        const members = typeNode
          .asKindOrThrow(SyntaxKind.TypeLiteral)
          .getMembers();
        members.forEach((member: any) => {
          if (member.getKind() === SyntaxKind.PropertySignature) {
            const name = member.getName();
            if (name) {
              props.push(name);
            }
          }
        });

        if (props.length > 0) {
          return props;
        }
      }

      // CASE 2b: Type reference
      if (typeNode.getKind() === SyntaxKind.TypeReference) {
        const typeName = typeNode.getTypeName().getText();
        const sourceFile = param.getSourceFile();

        // Try to resolve the type
        const resolvedProps = this.resolveTypeToProps(sourceFile, typeName);
        if (resolvedProps.length > 0) {
          return resolvedProps;
        }
      }
    }

    // CASE 3: Fallback - check if parameter name is "props"
    const paramName = param.getName();
    if (paramName === "props" && props.length === 0) {
      // Log that we found props but couldn't extract individual prop names
      this.log(
        `  Found 'props' parameter but couldn't extract individual props`,
      );
    }

    return props;
  }

  private resolveTypeToProps(sourceFile: any, typeName: string): string[] {
    const props: string[] = [];

    // Handle PropsWithChildren<T> and similar React utility types
    const propsWithChildrenMatch = typeName.match(
      /^(?:React\.)?PropsWithChildren<(.+)>$/,
    );
    if (propsWithChildrenMatch) {
      // Add 'children' prop and resolve the inner type
      props.push("children");
      const innerTypeName = propsWithChildrenMatch[1].trim();
      const innerProps = this.resolveTypeToProps(sourceFile, innerTypeName);
      props.push(...innerProps);
      return [...new Set(props)]; // Remove duplicates
    }

    // Handle PropsWithRef<T>
    const propsWithRefMatch = typeName.match(
      /^(?:React\.)?PropsWithRef<(.+)>$/,
    );
    if (propsWithRefMatch) {
      props.push("ref");
      const innerTypeName = propsWithRefMatch[1].trim();
      const innerProps = this.resolveTypeToProps(sourceFile, innerTypeName);
      props.push(...innerProps);
      return [...new Set(props)];
    }

    // Check type alias: type Props = { label: string }
    const typeAlias = sourceFile.getTypeAlias(typeName);
    if (typeAlias) {
      const aliasTypeNode = typeAlias.getTypeNode();
      if (aliasTypeNode) {
        // Type literal: { label: string }
        if (aliasTypeNode.getKind() === SyntaxKind.TypeLiteral) {
          const members = aliasTypeNode
            .asKindOrThrow(SyntaxKind.TypeLiteral)
            .getMembers();
          members.forEach((member: any) => {
            if (member.getKind() === SyntaxKind.PropertySignature) {
              const name = member.getName();
              if (name) {
                props.push(name);
              }
            }
          });
          return props;
        }

        // Intersection type: Props & OtherProps
        if (aliasTypeNode.getKind() === SyntaxKind.IntersectionType) {
          const types = aliasTypeNode
            .asKindOrThrow(SyntaxKind.IntersectionType)
            .getTypeNodes();
          types.forEach((typeNode: any) => {
            // Handle type literals in intersection
            if (typeNode.getKind() === SyntaxKind.TypeLiteral) {
              const members = typeNode
                .asKindOrThrow(SyntaxKind.TypeLiteral)
                .getMembers();
              members.forEach((member: any) => {
                if (member.getKind() === SyntaxKind.PropertySignature) {
                  const name = member.getName();
                  if (name) {
                    props.push(name);
                  }
                }
              });
            }
            // Handle type references in intersection (e.g., BaseProps & ExtendedProps)
            if (typeNode.getKind() === SyntaxKind.TypeReference) {
              const refTypeName = typeNode.getText();
              const refProps = this.resolveTypeToProps(sourceFile, refTypeName);
              props.push(...refProps);
            }
          });
          return [...new Set(props)]; // Remove duplicates
        }

        // Union type: Props = BaseProps | ExtendedProps (collect ALL possible props)
        if (aliasTypeNode.getKind() === SyntaxKind.UnionType) {
          const types = aliasTypeNode
            .asKindOrThrow(SyntaxKind.UnionType)
            .getTypeNodes();
          types.forEach((typeNode: any) => {
            // Handle type literals in union
            if (typeNode.getKind() === SyntaxKind.TypeLiteral) {
              const members = typeNode
                .asKindOrThrow(SyntaxKind.TypeLiteral)
                .getMembers();
              members.forEach((member: any) => {
                if (member.getKind() === SyntaxKind.PropertySignature) {
                  const name = member.getName();
                  if (name) {
                    props.push(name);
                  }
                }
              });
            }
            // Handle type references in union
            if (typeNode.getKind() === SyntaxKind.TypeReference) {
              const refTypeName = typeNode.getText();
              const refProps = this.resolveTypeToProps(sourceFile, refTypeName);
              props.push(...refProps);
            }
          });
          return [...new Set(props)]; // Remove duplicates
        }

        // Type reference (alias to another type): type Props = OtherProps
        if (aliasTypeNode.getKind() === SyntaxKind.TypeReference) {
          const refTypeName = aliasTypeNode.getText();
          return this.resolveTypeToProps(sourceFile, refTypeName);
        }
      }
    }

    // Check interface: interface Props { label: string }
    const interfaceDecl = sourceFile.getInterface(typeName);
    if (interfaceDecl) {
      const properties = interfaceDecl.getProperties();
      properties.forEach((prop: any) => {
        const name = prop.getName();
        if (name) {
          props.push(name);
        }
      });

      // Handle interface extends: interface Props extends BaseProps
      const extendedTypes = interfaceDecl.getExtends();
      extendedTypes.forEach((extendedType: any) => {
        const extendedTypeName = extendedType.getText();
        const extendedProps = this.resolveTypeToProps(
          sourceFile,
          extendedTypeName,
        );
        props.push(...extendedProps);
      });

      return [...new Set(props)]; // Remove duplicates
    }

    // Check imported types (limited support)
    // This is more complex and might require following import statements
    // For now, we'll just return what we have

    this.log(`  Could not resolve type '${typeName}' to props`);
    return props;
  }

  private extractComponentFromVariable(
    varDecl: any,
    filePath: string,
  ): any | null {
    const name = varDecl.getName();
    if (!/^[A-Z]/.test(name)) return null;

    const initializer = varDecl.getInitializer();
    if (!initializer) return null;

    const kind = initializer.getKind();

    // Handle direct arrow function or function expression
    if (
      kind === SyntaxKind.ArrowFunction ||
      kind === SyntaxKind.FunctionExpression
    ) {
      const funcExpr = initializer;
      const params = funcExpr.getParameters();
      let props =
        params.length > 0 ? this.extractPropsFromParameter(params[0]) : [];

      // If no props from parameters, try variable's type annotation (React.FC<Props>)
      if (props.length === 0) {
        const typeNode = varDecl.getTypeNode();
        if (typeNode && typeNode.getKind() === SyntaxKind.TypeReference) {
          const typeRef = typeNode.asKindOrThrow(SyntaxKind.TypeReference);
          const typeArgs = typeRef.getTypeArguments();

          // React.FC<Props> or FC<Props>
          if (typeArgs.length > 0) {
            const propsTypeArg = typeArgs[0];

            // Inline type: React.FC<{ label: string }>
            if (propsTypeArg.getKind() === SyntaxKind.TypeLiteral) {
              const members = propsTypeArg
                .asKindOrThrow(SyntaxKind.TypeLiteral)
                .getMembers();
              members.forEach((member: any) => {
                if (member.getKind() === SyntaxKind.PropertySignature) {
                  const propName = member.getName();
                  if (propName) {
                    props.push(propName);
                  }
                }
              });
            }

            // Type reference: React.FC<Props>
            if (propsTypeArg.getKind() === SyntaxKind.TypeReference) {
              const propsTypeName = propsTypeArg.getText();
              const sourceFile = varDecl.getSourceFile();
              props = this.resolveTypeToProps(sourceFile, propsTypeName);
            }
          }
        }
      }

      // Fallback: check for ComponentNameProps type definition
      if (props.length === 0) {
        const sourceFile = varDecl.getSourceFile();
        props = this.extractPropsFromTypeDefinition(sourceFile, name);
      }

      const varStatement = varDecl.getVariableStatement();
      let line = varDecl.getStartLineNumber();
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

    // Handle wrapped components: memo(), forwardRef()
    if (kind === SyntaxKind.CallExpression) {
      const callExpr = initializer.asKindOrThrow(SyntaxKind.CallExpression);
      const expression = callExpr.getExpression();

      // Get the function name (could be 'memo', 'React.memo', etc.)
      let funcName = "";
      if (expression.getKind() === SyntaxKind.Identifier) {
        funcName = expression.getText();
      } else if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
        const propAccess = expression.asKindOrThrow(
          SyntaxKind.PropertyAccessExpression,
        );
        funcName = `${propAccess.getExpression().getText()}.${propAccess.getName()}`;
      }

      // Check if it's a HOC wrapper we recognize
      const wrapperFunctions = [
        "memo",
        "forwardRef",
        "React.memo",
        "React.forwardRef",
        "observer", // mobx
        "connect", // redux (though this is complex)
      ];

      if (wrapperFunctions.some((wrapper) => funcName.endsWith(wrapper))) {
        const args = callExpr.getArguments();
        if (args.length > 0) {
          const firstArg = args[0];

          // Wrapped arrow function
          if (firstArg.getKind() === SyntaxKind.ArrowFunction) {
            const wrappedFunc = firstArg.asKindOrThrow(
              SyntaxKind.ArrowFunction,
            );
            const params = wrappedFunc.getParameters();
            let props =
              params.length > 0
                ? this.extractPropsFromParameter(params[0])
                : [];

            if (props.length === 0) {
              const sourceFile = varDecl.getSourceFile();
              props = this.extractPropsFromTypeDefinition(sourceFile, name);
            }

            const varStatement = varDecl.getVariableStatement();
            let line = varDecl.getStartLineNumber();
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

          // Wrapped function expression
          if (firstArg.getKind() === SyntaxKind.FunctionExpression) {
            const wrappedFunc = firstArg.asKindOrThrow(
              SyntaxKind.FunctionExpression,
            );
            const params = wrappedFunc.getParameters();
            let props =
              params.length > 0
                ? this.extractPropsFromParameter(params[0])
                : [];

            if (props.length === 0) {
              const sourceFile = varDecl.getSourceFile();
              props = this.extractPropsFromTypeDefinition(sourceFile, name);
            }

            const varStatement = varDecl.getVariableStatement();
            let line = varDecl.getStartLineNumber();
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
        }
      }
    }

    return null;
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
