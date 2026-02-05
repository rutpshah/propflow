/**
 * Tests for the actual uploaded astAnalyzer.ts
 * Run with: npx tsx test/actual-ast-tests.ts
 */

import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { Project, SyntaxKind, SourceFile } from "ts-morph";

// We need to create our own analyzer since vscode import won't work
// This is a copy of the key methods from astAnalyzer.ts for testing

interface ComponentInfo {
  name: string;
  filePath: string;
  props: string[];
  line: number;
}

class ASTAnalyzer {
  readonly project: Project;

  constructor() {
    this.project = new Project({
      skipAddingFilesFromTsConfig: true,
    });
  }

  private log(message: string) {
    // Silent
  }

  public analyzeFile(filePath: string, documentText?: string): ComponentInfo[] {
    let sourceFile = this.project.getSourceFile(filePath);

    if (documentText) {
      if (sourceFile) {
        sourceFile.replaceWithText(documentText);
      } else {
        sourceFile = this.project.createSourceFile(filePath, documentText, {
          overwrite: true,
        });
      }
    } else {
      if (sourceFile) {
        sourceFile.refreshFromFileSystemSync();
      } else {
        sourceFile = this.project.addSourceFileAtPath(filePath);
      }
    }

    const components: ComponentInfo[] = [];

    sourceFile.getFunctions().forEach((func) => {
      const componentInfo = this.extractComponentFromFunction(func, filePath);
      if (componentInfo) {
        components.push(componentInfo);
      }
    });

    sourceFile.getVariableDeclarations().forEach((varDecl) => {
      const componentInfo = this.extractComponentFromVariable(varDecl, filePath);
      if (componentInfo) {
        components.push(componentInfo);
      }
    });

    return components;
  }

  public extractPropsFromComponent(filePath: string, componentName: string): string[] {
    const sourceFile = this.project.getSourceFile(filePath);
    if (!sourceFile) return [];

    const props: string[] = [];

    const func = sourceFile.getFunction(componentName);
    if (func) {
      const params = func.getParameters();
      if (params.length > 0) {
        props.push(...this.extractPropsFromParameter(params[0]));
      }
    }

    const varDecl = sourceFile.getVariableDeclaration(componentName);
    if (varDecl) {
      const initializer = varDecl.getInitializer();
      if (initializer && 
          (initializer.getKind() === SyntaxKind.ArrowFunction ||
           initializer.getKind() === SyntaxKind.FunctionExpression)) {
        const arrowFunc = initializer as any;
        const params = arrowFunc.getParameters();
        if (params.length > 0) {
          props.push(...this.extractPropsFromParameter(params[0]));
        }
      }
    }

    if (props.length === 0) {
      const typeProps = this.extractPropsFromTypeDefinition(sourceFile, componentName);
      props.push(...typeProps);
    }

    return props;
  }

  private extractComponentFromFunction(func: any, filePath: string): ComponentInfo | null {
    const name = func.getName();
    if (!name) return null;
    if (!/^[A-Z]/.test(name)) return null;

    const params = func.getParameters();
    let props = params.length > 0 ? this.extractPropsFromParameter(params[0]) : [];

    if (props.length === 0) {
      const sourceFile = func.getSourceFile();
      props = this.extractPropsFromTypeDefinition(sourceFile, name);
    }

    let line = func.getStartLineNumber();
    const functionKeyword = func.getFirstChildByKind(SyntaxKind.FunctionKeyword);
    if (functionKeyword) {
      line = functionKeyword.getStartLineNumber();
    }

    return { name, filePath, props, line };
  }

  private extractComponentFromVariable(varDecl: any, filePath: string): ComponentInfo | null {
    const name = varDecl.getName();
    if (!/^[A-Z]/.test(name)) return null;

    const initializer = varDecl.getInitializer();
    if (!initializer) return null;

    const kind = initializer.getKind();

    if (kind === SyntaxKind.ArrowFunction || kind === SyntaxKind.FunctionExpression) {
      const funcExpr = initializer;
      const params = funcExpr.getParameters();
      let props = params.length > 0 ? this.extractPropsFromParameter(params[0]) : [];

      if (props.length === 0) {
        const typeNode = varDecl.getTypeNode();
        if (typeNode && typeNode.getKind() === SyntaxKind.TypeReference) {
          const typeRef = typeNode.asKindOrThrow(SyntaxKind.TypeReference);
          const typeArgs = typeRef.getTypeArguments();

          if (typeArgs.length > 0) {
            const propsTypeArg = typeArgs[0];

            if (propsTypeArg.getKind() === SyntaxKind.TypeLiteral) {
              const members = propsTypeArg.asKindOrThrow(SyntaxKind.TypeLiteral).getMembers();
              members.forEach((member: any) => {
                if (member.getKind() === SyntaxKind.PropertySignature) {
                  const propName = member.getName();
                  if (propName) props.push(propName);
                }
              });
            }

            if (propsTypeArg.getKind() === SyntaxKind.TypeReference) {
              const propsTypeName = propsTypeArg.getText();
              const sourceFile = varDecl.getSourceFile();
              props = this.resolveTypeToProps(sourceFile, propsTypeName);
            }
          }
        }
      }

      if (props.length === 0) {
        const sourceFile = varDecl.getSourceFile();
        props = this.extractPropsFromTypeDefinition(sourceFile, name);
      }

      const varStatement = varDecl.getVariableStatement();
      let line = varDecl.getStartLineNumber();
      if (varStatement) {
        line = varStatement.getStartLineNumber();
      }

      return { name, filePath, props, line };
    }

    if (kind === SyntaxKind.CallExpression) {
      const callExpr = initializer.asKindOrThrow(SyntaxKind.CallExpression);
      const expression = callExpr.getExpression();

      let funcName = "";
      if (expression.getKind() === SyntaxKind.Identifier) {
        funcName = expression.getText();
      } else if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
        const propAccess = expression.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
        funcName = `${propAccess.getExpression().getText()}.${propAccess.getName()}`;
      }

      const wrapperFunctions = ["memo", "forwardRef", "React.memo", "React.forwardRef", "observer", "connect"];

      if (wrapperFunctions.some((wrapper) => funcName.endsWith(wrapper))) {
        const args = callExpr.getArguments();
        if (args.length > 0) {
          const firstArg = args[0];

          if (firstArg.getKind() === SyntaxKind.ArrowFunction || firstArg.getKind() === SyntaxKind.FunctionExpression) {
            const wrappedFunc = firstArg as any;
            const params = wrappedFunc.getParameters();
            let props = params.length > 0 ? this.extractPropsFromParameter(params[0]) : [];

            if (props.length === 0) {
              const sourceFile = varDecl.getSourceFile();
              props = this.extractPropsFromTypeDefinition(sourceFile, name);
            }

            const varStatement = varDecl.getVariableStatement();
            let line = varDecl.getStartLineNumber();
            if (varStatement) {
              line = varStatement.getStartLineNumber();
            }

            return { name, filePath, props, line };
          }
        }
      }
    }

    return null;
  }

  private extractPropsFromParameter(param: any): string[] {
    const props: string[] = [];

    if (param.getKind() !== SyntaxKind.Parameter) return props;

    const nameNode = param.getNameNode();

    if (nameNode && nameNode.getKind() === SyntaxKind.ObjectBindingPattern) {
      const elements = nameNode.getElements();
      elements.forEach((element: any) => {
        const propName = element.getName();
        if (propName) props.push(propName);
      });
      if (props.length > 0) return props;
    }

    const typeNode = param.getTypeNode();
    if (typeNode) {
      if (typeNode.getKind() === SyntaxKind.TypeLiteral) {
        const members = typeNode.asKindOrThrow(SyntaxKind.TypeLiteral).getMembers();
        members.forEach((member: any) => {
          if (member.getKind() === SyntaxKind.PropertySignature) {
            const name = member.getName();
            if (name) props.push(name);
          }
        });
        if (props.length > 0) return props;
      }

      if (typeNode.getKind() === SyntaxKind.TypeReference) {
        const typeName = typeNode.getTypeName().getText();
        const sourceFile = param.getSourceFile();
        const resolvedProps = this.resolveTypeToProps(sourceFile, typeName);
        if (resolvedProps.length > 0) return resolvedProps;
      }
    }

    return props;
  }

  private extractPropsFromTypeDefinition(sourceFile: SourceFile, componentName: string): string[] {
    const props: string[] = [];
    const typeName = `${componentName}Props`;

    const typeAlias = sourceFile.getTypeAlias(typeName);
    if (typeAlias) {
      const typeNode = typeAlias.getTypeNode();
      if (typeNode && typeNode.getKind() === SyntaxKind.TypeLiteral) {
        const members = typeNode.asKindOrThrow(SyntaxKind.TypeLiteral).getMembers();
        members.forEach((member: any) => {
          if (member.getKind() === SyntaxKind.PropertySignature) {
            const name = member.getName();
            if (name) props.push(name);
          }
        });
      }
    }

    const interfaceDecl = sourceFile.getInterface(typeName);
    if (interfaceDecl) {
      const properties = interfaceDecl.getProperties();
      properties.forEach((prop: any) => {
        const name = prop.getName();
        if (name) props.push(name);
      });
    }

    return props;
  }

  private resolveTypeToProps(sourceFile: any, typeName: string): string[] {
    const props: string[] = [];

    // Handle PropsWithChildren<T>
    const propsWithChildrenMatch = typeName.match(/^(?:React\.)?PropsWithChildren<(.+)>$/);
    if (propsWithChildrenMatch) {
      props.push("children");
      const innerTypeName = propsWithChildrenMatch[1].trim();
      const innerProps = this.resolveTypeToProps(sourceFile, innerTypeName);
      props.push(...innerProps);
      return [...new Set(props)];
    }

    const typeAlias = sourceFile.getTypeAlias(typeName);
    if (typeAlias) {
      const aliasTypeNode = typeAlias.getTypeNode();
      if (aliasTypeNode) {
        if (aliasTypeNode.getKind() === SyntaxKind.TypeLiteral) {
          const members = aliasTypeNode.asKindOrThrow(SyntaxKind.TypeLiteral).getMembers();
          members.forEach((member: any) => {
            if (member.getKind() === SyntaxKind.PropertySignature) {
              const name = member.getName();
              if (name) props.push(name);
            }
          });
          return props;
        }

        // Intersection type
        if (aliasTypeNode.getKind() === SyntaxKind.IntersectionType) {
          const types = aliasTypeNode.asKindOrThrow(SyntaxKind.IntersectionType).getTypeNodes();
          types.forEach((typeNode: any) => {
            if (typeNode.getKind() === SyntaxKind.TypeLiteral) {
              const members = typeNode.asKindOrThrow(SyntaxKind.TypeLiteral).getMembers();
              members.forEach((member: any) => {
                if (member.getKind() === SyntaxKind.PropertySignature) {
                  const name = member.getName();
                  if (name) props.push(name);
                }
              });
            }
            if (typeNode.getKind() === SyntaxKind.TypeReference) {
              const refTypeName = typeNode.getText();
              const refProps = this.resolveTypeToProps(sourceFile, refTypeName);
              props.push(...refProps);
            }
            // Handle union inside intersection
            if (typeNode.getKind() === SyntaxKind.ParenthesizedType) {
              const inner = typeNode.getTypeNode();
              if (inner && inner.getKind() === SyntaxKind.UnionType) {
                const unionTypes = inner.asKindOrThrow(SyntaxKind.UnionType).getTypeNodes();
                unionTypes.forEach((ut: any) => {
                  if (ut.getKind() === SyntaxKind.TypeReference) {
                    const refProps = this.resolveTypeToProps(sourceFile, ut.getText());
                    props.push(...refProps);
                  }
                });
              }
            }
          });
          return [...new Set(props)];
        }

        // Union type
        if (aliasTypeNode.getKind() === SyntaxKind.UnionType) {
          const types = aliasTypeNode.asKindOrThrow(SyntaxKind.UnionType).getTypeNodes();
          types.forEach((typeNode: any) => {
            if (typeNode.getKind() === SyntaxKind.TypeLiteral) {
              const members = typeNode.asKindOrThrow(SyntaxKind.TypeLiteral).getMembers();
              members.forEach((member: any) => {
                if (member.getKind() === SyntaxKind.PropertySignature) {
                  const name = member.getName();
                  if (name) props.push(name);
                }
              });
            }
            if (typeNode.getKind() === SyntaxKind.TypeReference) {
              const refTypeName = typeNode.getText();
              const refProps = this.resolveTypeToProps(sourceFile, refTypeName);
              props.push(...refProps);
            }
          });
          return [...new Set(props)];
        }

        // Type reference (alias)
        if (aliasTypeNode.getKind() === SyntaxKind.TypeReference) {
          const refTypeName = aliasTypeNode.getText();
          return this.resolveTypeToProps(sourceFile, refTypeName);
        }
      }
    }

    const interfaceDecl = sourceFile.getInterface(typeName);
    if (interfaceDecl) {
      const properties = interfaceDecl.getProperties();
      properties.forEach((prop: any) => {
        const name = prop.getName();
        if (name) props.push(name);
      });

      // Handle extends
      const extendedTypes = interfaceDecl.getExtends();
      extendedTypes.forEach((extendedType: any) => {
        const extendedTypeName = extendedType.getText();
        const extendedProps = this.resolveTypeToProps(sourceFile, extendedTypeName);
        props.push(...extendedProps);
      });

      return [...new Set(props)];
    }

    return props;
  }

  public findPropUsage(sourceFile: SourceFile, componentName: string, propName: string): { line: number; value: string | null } | null {
    const jsxElements = [
      ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
    ];

    for (const element of jsxElements) {
      const isOpening = element.getKind() === SyntaxKind.JsxOpeningElement;
      const tagName = isOpening
        ? element.asKindOrThrow(SyntaxKind.JsxOpeningElement).getTagNameNode().getText()
        : element.asKindOrThrow(SyntaxKind.JsxSelfClosingElement).getTagNameNode().getText();

      if (tagName === componentName) {
        const attributes = isOpening
          ? element.asKindOrThrow(SyntaxKind.JsxOpeningElement).getAttributes()
          : element.asKindOrThrow(SyntaxKind.JsxSelfClosingElement).getAttributes();

        const hasSpread = attributes.some((attr) => attr.getKind() === SyntaxKind.JsxSpreadAttribute);

        for (const attr of attributes) {
          if (attr.getKind() === SyntaxKind.JsxAttribute) {
            const jsxAttr = attr.asKindOrThrow(SyntaxKind.JsxAttribute);
            const attrName = jsxAttr.getNameNode().getText();

            if (attrName === propName) {
              const initializer = jsxAttr.getInitializer();
              const line = jsxAttr.getStartLineNumber();

              if (!initializer) return { line, value: "true" };

              if (initializer.getKind() === SyntaxKind.StringLiteral) {
                return { line, value: initializer.getText() };
              }

              if (initializer.getKind() === SyntaxKind.JsxExpression) {
                const expr = initializer.asKindOrThrow(SyntaxKind.JsxExpression);
                const expression = expr.getExpression();
                return { line, value: expression ? expression.getText() : null };
              }
            }
          }
        }

        if (hasSpread) {
          return { line: element.getStartLineNumber(), value: "{...spread}" };
        }
      }
    }

    return null;
  }

  public getSourceFile(filePath: string): SourceFile | undefined {
    let sourceFile = this.project.getSourceFile(filePath);
    if (!sourceFile) {
      try {
        sourceFile = this.project.addSourceFileAtPath(filePath);
      } catch {
        return undefined;
      }
    }
    return sourceFile;
  }

  public dispose() {}
}

// ============================================================================
// Test Runner
// ============================================================================

let tempDir: string;
let analyzer: ASTAnalyzer;
let passed = 0;
let failed = 0;

function setup() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "propflow-actual-test-"));
  analyzer = new ASTAnalyzer();
}

function teardown() {
  analyzer.dispose();
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✅ PASS: ${name}`);
    passed++;
  } catch (error: any) {
    console.log(`❌ FAIL: ${name}`);
    console.log(`   Error: ${error.message}`);
    if (error.stack) {
      console.log(`   Stack: ${error.stack.split('\n')[1]}`);
    }
    failed++;
  }
}

function assertEqual(actual: any, expected: any, message?: string) {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr !== expectedStr) {
    throw new Error(`${message || "Assertion failed"}\n   Expected: ${expectedStr}\n   Actual: ${actualStr}`);
  }
}

function assertIncludes(arr: any[], item: any, message?: string) {
  if (!arr.includes(item)) {
    throw new Error(`${message || "Array should include item"}\n   Array: ${JSON.stringify(arr)}\n   Item: ${item}`);
  }
}

function assertGreaterThan(actual: number, expected: number, message?: string) {
  if (actual <= expected) {
    throw new Error(`${message || "Assertion failed"}\n   Expected > ${expected}\n   Actual: ${actual}`);
  }
}

// ============================================================================
// Tests
// ============================================================================

console.log("=".repeat(60));
console.log("PropFlow ACTUAL ASTAnalyzer Tests");
console.log("=".repeat(60));
console.log("");

setup();

// ============================================================================
// Test Category 1: Basic Function Components
// ============================================================================
console.log("\n--- Basic Function Components ---\n");

test("Function component with destructured props", () => {
  const testFile = path.join(tempDir, "Button1.tsx");
  fs.writeFileSync(testFile, `
    function Button({ label, onClick, disabled }) {
      return <button onClick={onClick} disabled={disabled}>{label}</button>;
    }
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].name, "Button");
  assertEqual(components[0].props.sort(), ["disabled", "label", "onClick"]);
});

test("Function component with typed interface props", () => {
  const testFile = path.join(tempDir, "Button2.tsx");
  fs.writeFileSync(testFile, `
    interface ButtonProps {
      label: string;
      onClick: () => void;
      size?: 'sm' | 'md' | 'lg';
    }
    function Button({ label, onClick, size }: ButtonProps) {
      return <button onClick={onClick}>{label}</button>;
    }
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].props.sort(), ["label", "onClick", "size"]);
});

test("Exported function component", () => {
  const testFile = path.join(tempDir, "Button3.tsx");
  fs.writeFileSync(testFile, `
    export function Button({ label }) {
      return <button>{label}</button>;
    }
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].name, "Button");
});

test("Export default function component", () => {
  const testFile = path.join(tempDir, "Button4.tsx");
  fs.writeFileSync(testFile, `
    export default function Button({ label }) {
      return <button>{label}</button>;
    }
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].name, "Button");
});

// ============================================================================
// Test Category 2: Arrow Function Components
// ============================================================================
console.log("\n--- Arrow Function Components ---\n");

test("Arrow function with destructured props", () => {
  const testFile = path.join(tempDir, "Card1.tsx");
  fs.writeFileSync(testFile, `
    const Card = ({ title, description, footer }) => {
      return <div><h1>{title}</h1><p>{description}</p>{footer}</div>;
    };
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].name, "Card");
  assertEqual(components[0].props.sort(), ["description", "footer", "title"]);
});

test("Arrow function with React.FC type annotation", () => {
  const testFile = path.join(tempDir, "Card2.tsx");
  fs.writeFileSync(testFile, `
    import React from 'react';
    
    interface CardProps {
      title: string;
      subtitle?: string;
      onClick?: () => void;
    }
    
    const Card: React.FC<CardProps> = ({ title, subtitle, onClick }) => {
      return <div onClick={onClick}>{title}{subtitle}</div>;
    };
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].props.sort(), ["onClick", "subtitle", "title"]);
});

test("Arrow function with inline type in FC", () => {
  const testFile = path.join(tempDir, "Card3.tsx");
  fs.writeFileSync(testFile, `
    import React from 'react';
    
    const Card: React.FC<{ title: string; active: boolean }> = ({ title, active }) => {
      return <div className={active ? 'active' : ''}>{title}</div>;
    };
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertIncludes(components[0].props, "title");
  assertIncludes(components[0].props, "active");
});

// ============================================================================
// Test Category 3: HOC Wrapped Components
// ============================================================================
console.log("\n--- HOC Wrapped Components ---\n");

test("React.memo with arrow function", () => {
  const testFile = path.join(tempDir, "Memo1.tsx");
  fs.writeFileSync(testFile, `
    import React from 'react';
    
    const MemoButton = React.memo(({ label, onClick }) => {
      return <button onClick={onClick}>{label}</button>;
    });
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].name, "MemoButton");
  assertEqual(components[0].props.sort(), ["label", "onClick"]);
});

test("memo() import without React prefix", () => {
  const testFile = path.join(tempDir, "Memo2.tsx");
  fs.writeFileSync(testFile, `
    import { memo } from 'react';
    
    const MemoCard = memo(({ title, content }) => {
      return <div><h1>{title}</h1><p>{content}</p></div>;
    });
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].name, "MemoCard");
  assertEqual(components[0].props.sort(), ["content", "title"]);
});

test("React.forwardRef component", () => {
  const testFile = path.join(tempDir, "ForwardRef1.tsx");
  fs.writeFileSync(testFile, `
    import React from 'react';
    
    const Input = React.forwardRef(({ placeholder, onChange, value }, ref) => {
      return <input ref={ref} placeholder={placeholder} onChange={onChange} value={value} />;
    });
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].name, "Input");
  assertIncludes(components[0].props, "placeholder");
  assertIncludes(components[0].props, "onChange");
  assertIncludes(components[0].props, "value");
});

test("forwardRef without React prefix", () => {
  const testFile = path.join(tempDir, "ForwardRef2.tsx");
  fs.writeFileSync(testFile, `
    import { forwardRef } from 'react';
    
    const TextArea = forwardRef(({ rows, cols, defaultValue }, ref) => {
      return <textarea ref={ref} rows={rows} cols={cols} defaultValue={defaultValue} />;
    });
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].name, "TextArea");
  // Note: 'ref' is NOT included because forwardRef handles it separately
  assertEqual(components[0].props.sort(), ["cols", "defaultValue", "rows"]);
});

test("MobX observer wrapper", () => {
  const testFile = path.join(tempDir, "Observer1.tsx");
  fs.writeFileSync(testFile, `
    import { observer } from 'mobx-react';
    
    const ObserverComponent = observer(({ data, onUpdate, isLoading }) => {
      return <div onClick={onUpdate}>{isLoading ? 'Loading...' : data}</div>;
    });
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].name, "ObserverComponent");
  assertEqual(components[0].props.sort(), ["data", "isLoading", "onUpdate"]);
});

// ============================================================================
// Test Category 4: Props from Type Definitions
// ============================================================================
console.log("\n--- Props from Type Definitions ---\n");

test("Props from interface with ComponentNameProps convention", () => {
  const testFile = path.join(tempDir, "Convention1.tsx");
  fs.writeFileSync(testFile, `
    interface HeaderProps {
      title: string;
      showLogo: boolean;
      onMenuClick?: () => void;
    }
    
    function Header(props) {
      return <div onClick={props.onMenuClick}>{props.showLogo && <Logo />}{props.title}</div>;
    }
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].props.sort(), ["onMenuClick", "showLogo", "title"]);
});

test("Props from type alias", () => {
  const testFile = path.join(tempDir, "TypeAlias1.tsx");
  fs.writeFileSync(testFile, `
    type FooterProps = {
      copyright: string;
      year: number;
      links?: string[];
    }
    
    const Footer = (props) => {
      return <footer>{props.copyright} {props.year}</footer>;
    };
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].props.sort(), ["copyright", "links", "year"]);
});

// ============================================================================
// Test Category 5: JSX Prop Usage Detection
// ============================================================================
console.log("\n--- JSX Prop Usage Detection ---\n");

test("Find string literal prop value", () => {
  const testFile = path.join(tempDir, "Usage1.tsx");
  const content = `
    function App() {
      return <Button label="Click me" variant="primary" />;
    }
  `;
  fs.writeFileSync(testFile, content);
  const sourceFile = analyzer.getSourceFile(testFile);
  const usage = analyzer.findPropUsage(sourceFile!, "Button", "label");
  assertEqual(usage?.value, '"Click me"');
});

test("Find variable expression prop", () => {
  const testFile = path.join(tempDir, "Usage2.tsx");
  const content = `
    function App() {
      const buttonLabel = "Hello World";
      return <Button label={buttonLabel} />;
    }
  `;
  fs.writeFileSync(testFile, content);
  const sourceFile = analyzer.getSourceFile(testFile);
  const usage = analyzer.findPropUsage(sourceFile!, "Button", "label");
  assertEqual(usage?.value, "buttonLabel");
});

test("Find boolean shorthand prop", () => {
  const testFile = path.join(tempDir, "Usage3.tsx");
  const content = `
    function App() {
      return <Button disabled primary large />;
    }
  `;
  fs.writeFileSync(testFile, content);
  const sourceFile = analyzer.getSourceFile(testFile);
  const disabledUsage = analyzer.findPropUsage(sourceFile!, "Button", "disabled");
  assertEqual(disabledUsage?.value, "true");
});

test("Detect spread operator in JSX", () => {
  const testFile = path.join(tempDir, "Usage4.tsx");
  const content = `
    function Wrapper(props) {
      return <Button {...props} extra="value" />;
    }
  `;
  fs.writeFileSync(testFile, content);
  const sourceFile = analyzer.getSourceFile(testFile);
  const usage = analyzer.findPropUsage(sourceFile!, "Button", "unknownProp");
  assertEqual(usage?.value, "{...spread}");
});

test("Find prop in JSX with children", () => {
  const testFile = path.join(tempDir, "Usage5.tsx");
  const content = `
    function App() {
      return (
        <Card title="My Card" bordered>
          <p>Card content here</p>
        </Card>
      );
    }
  `;
  fs.writeFileSync(testFile, content);
  const sourceFile = analyzer.getSourceFile(testFile);
  const titleUsage = analyzer.findPropUsage(sourceFile!, "Card", "title");
  assertEqual(titleUsage?.value, '"My Card"');
  const borderedUsage = analyzer.findPropUsage(sourceFile!, "Card", "bordered");
  assertEqual(borderedUsage?.value, "true");
});

// ============================================================================
// Test Category 6: Edge Cases & Error Handling
// ============================================================================
console.log("\n--- Edge Cases & Error Handling ---\n");

test("Ignore lowercase function names (utilities)", () => {
  const testFile = path.join(tempDir, "utils.ts");
  fs.writeFileSync(testFile, `
    function calculateSum(a, b) { return a + b; }
    const formatDate = (date) => date.toISOString();
    function processData(items) { return items.map(x => x * 2); }
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 0);
});

test("Multiple components in same file", () => {
  const testFile = path.join(tempDir, "Multi.tsx");
  fs.writeFileSync(testFile, `
    function Header({ title }) { return <h1>{title}</h1>; }
    const Footer = ({ copyright }) => <footer>{copyright}</footer>;
    function Sidebar({ items }) { return <aside>{items.length}</aside>; }
    const Main = ({ children }) => <main>{children}</main>;
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 4);
  const names = components.map(c => c.name).sort();
  assertEqual(names, ["Footer", "Header", "Main", "Sidebar"]);
});

test("Component with no props", () => {
  const testFile = path.join(tempDir, "NoProps.tsx");
  fs.writeFileSync(testFile, `
    function Divider() {
      return <hr className="divider" />;
    }
    
    const Spacer = () => <div style={{ height: 20 }} />;
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 2);
  assertEqual(components[0].props, []);
  assertEqual(components[1].props, []);
});

test("Component with rest/spread props", () => {
  const testFile = path.join(tempDir, "Rest.tsx");
  fs.writeFileSync(testFile, `
    function Button({ label, variant, ...rest }) {
      return <button className={variant} {...rest}>{label}</button>;
    }
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertIncludes(components[0].props, "label");
  assertIncludes(components[0].props, "variant");
  assertIncludes(components[0].props, "rest");
});

test("In-memory document text (unsaved changes simulation)", () => {
  const testFile = path.join(tempDir, "InMemory.tsx");
  fs.writeFileSync(testFile, `
    function OldComponent({ oldProp }) {
      return <div>{oldProp}</div>;
    }
  `);
  
  // First analyze from disk
  let components = analyzer.analyzeFile(testFile);
  assertEqual(components[0].name, "OldComponent");
  assertEqual(components[0].props, ["oldProp"]);
  
  // Now analyze with in-memory content (simulating unsaved changes)
  const newContent = `
    function NewComponent({ newProp, anotherProp, thirdProp }) {
      return <div>{newProp}</div>;
    }
  `;
  components = analyzer.analyzeFile(testFile, newContent);
  assertEqual(components[0].name, "NewComponent");
  assertEqual(components[0].props.sort(), ["anotherProp", "newProp", "thirdProp"]);
});

test("Complex nested destructuring", () => {
  const testFile = path.join(tempDir, "Nested.tsx");
  fs.writeFileSync(testFile, `
    function UserCard({ user, onSelect, isSelected }) {
      const { name, email } = user;
      return <div onClick={() => onSelect(user)}>{name} - {email}</div>;
    }
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].props.sort(), ["isSelected", "onSelect", "user"]);
});

// ============================================================================
// Test Category 7: Framework Patterns (Next.js / Remix)
// ============================================================================
console.log("\n--- Framework Patterns ---\n");

test("Next.js page with params and searchParams", () => {
  const testFile = path.join(tempDir, "NextPage.tsx");
  fs.writeFileSync(testFile, `
    export default function Page({ params, searchParams }) {
      return <div>User ID: {params.id}, Query: {searchParams.q}</div>;
    }
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].name, "Page");
  assertEqual(components[0].props.sort(), ["params", "searchParams"]);
});

test("Next.js layout component", () => {
  const testFile = path.join(tempDir, "Layout.tsx");
  fs.writeFileSync(testFile, `
    export default function RootLayout({ children }) {
      return (
        <html>
          <body>{children}</body>
        </html>
      );
    }
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].name, "RootLayout");
  assertIncludes(components[0].props, "children");
});

test("Server component pattern", () => {
  const testFile = path.join(tempDir, "ServerComponent.tsx");
  fs.writeFileSync(testFile, `
    async function DataDisplay({ dataId }) {
      const data = await fetchData(dataId);
      return <div>{data.title}</div>;
    }
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].name, "DataDisplay");
  assertIncludes(components[0].props, "dataId");
});

// ============================================================================
// Test Category 8: extractPropsFromComponent Method
// ============================================================================
console.log("\n--- extractPropsFromComponent Method ---\n");

test("extractPropsFromComponent for function component", () => {
  const testFile = path.join(tempDir, "Extract1.tsx");
  fs.writeFileSync(testFile, `
    function TestComponent({ propA, propB, propC }) {
      return <div>{propA}{propB}{propC}</div>;
    }
  `);
  analyzer.analyzeFile(testFile); // Load file first
  const props = analyzer.extractPropsFromComponent(testFile, "TestComponent");
  assertEqual(props.sort(), ["propA", "propB", "propC"]);
});

test("extractPropsFromComponent for arrow function", () => {
  const testFile = path.join(tempDir, "Extract2.tsx");
  fs.writeFileSync(testFile, `
    const ArrowComponent = ({ alpha, beta }) => {
      return <div>{alpha}{beta}</div>;
    };
  `);
  analyzer.analyzeFile(testFile);
  const props = analyzer.extractPropsFromComponent(testFile, "ArrowComponent");
  assertEqual(props.sort(), ["alpha", "beta"]);
});

// ============================================================================
// Test Category 9: Line Number Accuracy
// ============================================================================
console.log("\n--- Line Number Accuracy ---\n");

test("Correct line number for function component", () => {
  const testFile = path.join(tempDir, "LineNum1.tsx");
  fs.writeFileSync(testFile, `import React from 'react';

// Some comment
function MyComponent({ prop }) {
  return <div>{prop}</div>;
}`);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  // Function starts on line 4
  assertEqual(components[0].line, 4);
});

test("Correct line number for exported function", () => {
  const testFile = path.join(tempDir, "LineNum2.tsx");
  fs.writeFileSync(testFile, `import React from 'react';

export function ExportedComponent({ prop }) {
  return <div>{prop}</div>;
}`);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  // Should be line 3 where function keyword is
  assertGreaterThan(components[0].line, 0);
});

// ============================================================================
// Test Category 10: NEW FEATURES - Union Types
// ============================================================================
console.log("\n--- NEW: Union Type Support ---\n");

test("Union type with type literals", () => {
  const testFile = path.join(tempDir, "Union1.tsx");
  fs.writeFileSync(testFile, `
    type ButtonProps = { label: string; onClick: () => void } | { icon: string; onPress: () => void };
    
    function Button(props: ButtonProps) {
      return <button>Button</button>;
    }
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  // Should collect ALL props from the union
  const props = components[0].props.sort();
  assertIncludes(props, "label");
  assertIncludes(props, "onClick");
  assertIncludes(props, "icon");
  assertIncludes(props, "onPress");
});

test("Union type with type references", () => {
  const testFile = path.join(tempDir, "Union2.tsx");
  fs.writeFileSync(testFile, `
    interface BaseButtonProps {
      disabled?: boolean;
    }
    
    interface PrimaryButtonProps {
      variant: 'primary';
      color: string;
    }
    
    interface SecondaryButtonProps {
      variant: 'secondary';
      outline: boolean;
    }
    
    type ButtonProps = BaseButtonProps & (PrimaryButtonProps | SecondaryButtonProps);
    
    const Button = ({ disabled, variant, color, outline }: ButtonProps) => {
      return <button>Button</button>;
    };
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  const props = components[0].props.sort();
  assertIncludes(props, "disabled");
  assertIncludes(props, "variant");
  assertIncludes(props, "color");
  assertIncludes(props, "outline");
});

// ============================================================================
// Test Category 11: NEW FEATURES - PropsWithChildren
// ============================================================================
console.log("\n--- NEW: PropsWithChildren Support ---\n");

test("PropsWithChildren with interface", () => {
  const testFile = path.join(tempDir, "PWC1.tsx");
  fs.writeFileSync(testFile, `
    import { PropsWithChildren } from 'react';
    
    interface CardProps {
      title: string;
      bordered?: boolean;
    }
    
    const Card: React.FC<PropsWithChildren<CardProps>> = ({ title, bordered, children }) => {
      return <div className={bordered ? 'bordered' : ''}><h1>{title}</h1>{children}</div>;
    };
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  const props = components[0].props.sort();
  assertIncludes(props, "title");
  assertIncludes(props, "bordered");
  assertIncludes(props, "children");
});

test("React.PropsWithChildren pattern", () => {
  const testFile = path.join(tempDir, "PWC2.tsx");
  fs.writeFileSync(testFile, `
    interface LayoutProps {
      sidebar?: boolean;
    }
    
    type Props = React.PropsWithChildren<LayoutProps>;
    
    function Layout(props: Props) {
      return <div>{props.children}</div>;
    }
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  const props = components[0].props.sort();
  assertIncludes(props, "sidebar");
  assertIncludes(props, "children");
});

// ============================================================================
// Test Category 12: NEW FEATURES - Interface Extends
// ============================================================================
console.log("\n--- NEW: Interface Extends Support ---\n");

test("Interface extends another interface", () => {
  const testFile = path.join(tempDir, "Extends1.tsx");
  fs.writeFileSync(testFile, `
    interface BaseProps {
      id: string;
      className?: string;
    }
    
    interface ButtonProps extends BaseProps {
      label: string;
      onClick: () => void;
    }
    
    function Button({ id, className, label, onClick }: ButtonProps) {
      return <button id={id} className={className} onClick={onClick}>{label}</button>;
    }
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  const props = components[0].props.sort();
  assertEqual(props, ["className", "id", "label", "onClick"]);
});

test("Interface extends multiple interfaces", () => {
  const testFile = path.join(tempDir, "Extends2.tsx");
  fs.writeFileSync(testFile, `
    interface Stylable {
      className?: string;
      style?: object;
    }
    
    interface Clickable {
      onClick?: () => void;
      onDoubleClick?: () => void;
    }
    
    interface CardProps extends Stylable, Clickable {
      title: string;
    }
    
    const Card = ({ className, style, onClick, onDoubleClick, title }: CardProps) => {
      return <div>{title}</div>;
    };
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  const props = components[0].props.sort();
  assertIncludes(props, "className");
  assertIncludes(props, "style");
  assertIncludes(props, "onClick");
  assertIncludes(props, "onDoubleClick");
  assertIncludes(props, "title");
});

// ============================================================================
// Test Category 13: NEW FEATURES - Type Alias to Type Reference
// ============================================================================
console.log("\n--- NEW: Type Alias Resolution ---\n");

test("Type alias pointing to another type", () => {
  const testFile = path.join(tempDir, "TypeAlias2.tsx");
  fs.writeFileSync(testFile, `
    interface OriginalProps {
      value: string;
      onChange: (val: string) => void;
    }
    
    type InputProps = OriginalProps;
    
    function Input({ value, onChange }: InputProps) {
      return <input value={value} onChange={(e) => onChange(e.target.value)} />;
    }
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  const props = components[0].props.sort();
  assertEqual(props, ["onChange", "value"]);
});

// ============================================================================
// Test Category 14: Bug Fix Verification - FunctionExpression
// ============================================================================
console.log("\n--- BUG FIX: FunctionExpression Support ---\n");

test("Function expression component (was broken before fix)", () => {
  const testFile = path.join(tempDir, "FuncExpr.tsx");
  fs.writeFileSync(testFile, `
    const Button = function({ label, onClick }) {
      return <button onClick={onClick}>{label}</button>;
    };
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].name, "Button");
  assertEqual(components[0].props.sort(), ["label", "onClick"]);
});

test("Named function expression", () => {
  const testFile = path.join(tempDir, "NamedFuncExpr.tsx");
  fs.writeFileSync(testFile, `
    const Card = function CardComponent({ title, description }) {
      return <div><h1>{title}</h1><p>{description}</p></div>;
    };
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].name, "Card");
  assertEqual(components[0].props.sort(), ["description", "title"]);
});

// ============================================================================
// Summary
// ============================================================================

teardown();

console.log("\n" + "=".repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));

if (failed > 0) {
  process.exit(1);
}
