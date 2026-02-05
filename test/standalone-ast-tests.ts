/**
 * Comprehensive standalone tests for PropFlow ASTAnalyzer
 * Run with: npx ts-node test/standalone-ast-tests.ts
 */

import {
  Project,
  SourceFile,
  SyntaxKind,
} from "ts-morph";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// ============================================================================
// Mock vscode module (since we're running outside VS Code)
// ============================================================================
const mockVscode = {
  OutputChannel: class {
    appendLine(msg: string) { /* no-op */ }
  }
};

// ============================================================================
// Import the actual ASTAnalyzer class (inline for standalone testing)
// ============================================================================

interface ComponentInfo {
  name: string;
  filePath: string;
  props: string[];
  line: number;
}

class ASTAnalyzer {
  readonly project: Project;

  constructor(readonly outputChannel?: any) {
    this.project = new Project({
      skipAddingFilesFromTsConfig: true,
    });
  }

  private log(message: string) {
    // Silent in tests
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

    // Find function components
    sourceFile.getFunctions().forEach((func) => {
      const componentInfo = this.extractComponentFromFunction(func, filePath);
      if (componentInfo) {
        components.push(componentInfo);
      }
    });

    // Find arrow function components
    sourceFile.getVariableDeclarations().forEach((varDecl) => {
      const componentInfo = this.extractComponentFromVariable(varDecl, filePath);
      if (componentInfo) {
        components.push(componentInfo);
      }
    });

    return components;
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

    // Handle direct arrow function or function expression
    if (kind === SyntaxKind.ArrowFunction || kind === SyntaxKind.FunctionExpression) {
      const funcExpr = initializer;
      const params = funcExpr.getParameters();
      let props = params.length > 0 ? this.extractPropsFromParameter(params[0]) : [];

      // If no props from parameters, try variable's type annotation (React.FC<Props>)
      if (props.length === 0) {
        const typeNode = varDecl.getTypeNode();
        if (typeNode && typeNode.getKind() === SyntaxKind.TypeReference) {
          const typeRef = typeNode.asKindOrThrow(SyntaxKind.TypeReference);
          const typeArgs = typeRef.getTypeArguments();

          if (typeArgs.length > 0) {
            const propsTypeArg = typeArgs[0];

            // Inline type: React.FC<{ label: string }>
            if (propsTypeArg.getKind() === SyntaxKind.TypeLiteral) {
              const members = propsTypeArg.asKindOrThrow(SyntaxKind.TypeLiteral).getMembers();
              members.forEach((member: any) => {
                if (member.getKind() === SyntaxKind.PropertySignature) {
                  const propName = member.getName();
                  if (propName) props.push(propName);
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

      return { name, filePath, props, line };
    }

    // Handle wrapped components: memo(), forwardRef()
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
            const wrappedFunc = firstArg;
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

    // CASE 1: Destructured props
    if (nameNode && nameNode.getKind() === SyntaxKind.ObjectBindingPattern) {
      const elements = nameNode.getElements();
      elements.forEach((element: any) => {
        const propName = element.getName();
        if (propName) props.push(propName);
      });
      if (props.length > 0) return props;
    }

    // CASE 2: Non-destructured parameter with type annotation
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
          });
          return props;
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
      return props;
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "propflow-test-"));
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

// ============================================================================
// Tests
// ============================================================================

console.log("=".repeat(60));
console.log("PropFlow ASTAnalyzer Comprehensive Tests");
console.log("=".repeat(60));
console.log("");

setup();

// ============================================================================
// Test Category 1: Function Components
// ============================================================================
console.log("\n--- Function Components ---\n");

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

test("Function component with typed destructured props", () => {
  const testFile = path.join(tempDir, "Button2.tsx");
  fs.writeFileSync(testFile, `
    interface ButtonProps {
      label: string;
      onClick: () => void;
    }
    function Button({ label, onClick }: ButtonProps) {
      return <button onClick={onClick}>{label}</button>;
    }
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].props.sort(), ["label", "onClick"]);
});

test("Function component with inline type", () => {
  const testFile = path.join(tempDir, "Button3.tsx");
  fs.writeFileSync(testFile, `
    function Button({ label }: { label: string; size?: number }) {
      return <button>{label}</button>;
    }
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertIncludes(components[0].props, "label");
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

test("Arrow function component with destructured props", () => {
  const testFile = path.join(tempDir, "Card1.tsx");
  fs.writeFileSync(testFile, `
    const Card = ({ title, description }) => {
      return <div><h1>{title}</h1><p>{description}</p></div>;
    };
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].name, "Card");
  assertEqual(components[0].props.sort(), ["description", "title"]);
});

test("Arrow function with React.FC and interface props", () => {
  const testFile = path.join(tempDir, "Card2.tsx");
  fs.writeFileSync(testFile, `
    import React from 'react';
    
    interface CardProps {
      title: string;
      subtitle?: string;
    }
    
    const Card: React.FC<CardProps> = ({ title, subtitle }) => {
      return <div>{title}{subtitle}</div>;
    };
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].props.sort(), ["subtitle", "title"]);
});

test("Arrow function with React.FC and inline type", () => {
  const testFile = path.join(tempDir, "Card3.tsx");
  fs.writeFileSync(testFile, `
    import React from 'react';
    
    const Card: React.FC<{ title: string; active: boolean }> = ({ title, active }) => {
      return <div>{title}</div>;
    };
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertIncludes(components[0].props, "title");
  assertIncludes(components[0].props, "active");
});

test("Arrow function with FC shorthand", () => {
  const testFile = path.join(tempDir, "Card4.tsx");
  fs.writeFileSync(testFile, `
    import { FC } from 'react';
    
    type CardProps = {
      title: string;
    }
    
    const Card: FC<CardProps> = ({ title }) => {
      return <div>{title}</div>;
    };
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertIncludes(components[0].props, "title");
});

// ============================================================================
// Test Category 3: HOC Wrapped Components
// ============================================================================
console.log("\n--- HOC Wrapped Components ---\n");

test("React.memo wrapped component", () => {
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

test("memo() without React prefix", () => {
  const testFile = path.join(tempDir, "Memo2.tsx");
  fs.writeFileSync(testFile, `
    import { memo } from 'react';
    
    const MemoCard = memo(({ title }) => {
      return <div>{title}</div>;
    });
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].name, "MemoCard");
  assertIncludes(components[0].props, "title");
});

test("forwardRef wrapped component", () => {
  const testFile = path.join(tempDir, "ForwardRef1.tsx");
  fs.writeFileSync(testFile, `
    import React from 'react';
    
    const Input = React.forwardRef(({ placeholder, onChange }, ref) => {
      return <input ref={ref} placeholder={placeholder} onChange={onChange} />;
    });
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].name, "Input");
  assertIncludes(components[0].props, "placeholder");
  assertIncludes(components[0].props, "onChange");
});

test("MobX observer wrapped component", () => {
  const testFile = path.join(tempDir, "Observer1.tsx");
  fs.writeFileSync(testFile, `
    import { observer } from 'mobx-react';
    
    const ObserverComponent = observer(({ data, onUpdate }) => {
      return <div onClick={onUpdate}>{data}</div>;
    });
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].name, "ObserverComponent");
  assertEqual(components[0].props.sort(), ["data", "onUpdate"]);
});

// ============================================================================
// Test Category 4: Props from Type Definitions
// ============================================================================
console.log("\n--- Props from Type Definitions ---\n");

test("Props from ComponentNameProps convention", () => {
  const testFile = path.join(tempDir, "Convention1.tsx");
  fs.writeFileSync(testFile, `
    interface HeaderProps {
      title: string;
      showLogo: boolean;
    }
    
    function Header(props) {
      return <div>{props.title}</div>;
    }
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].props.sort(), ["showLogo", "title"]);
});

test("Props from type alias", () => {
  const testFile = path.join(tempDir, "TypeAlias1.tsx");
  fs.writeFileSync(testFile, `
    type FooterProps = {
      copyright: string;
      year: number;
    }
    
    const Footer = (props) => {
      return <footer>{props.copyright}</footer>;
    };
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].props.sort(), ["copyright", "year"]);
});

// ============================================================================
// Test Category 5: JSX Prop Usage Detection
// ============================================================================
console.log("\n--- JSX Prop Usage Detection ---\n");

test("Find string literal prop", () => {
  const testFile = path.join(tempDir, "Usage1.tsx");
  const content = `
    function App() {
      return <Button label="Click me" />;
    }
  `;
  fs.writeFileSync(testFile, content);
  const sourceFile = analyzer.getSourceFile(testFile);
  const usage = analyzer.findPropUsage(sourceFile!, "Button", "label");
  assertEqual(usage?.value, '"Click me"');
});

test("Find expression prop", () => {
  const testFile = path.join(tempDir, "Usage2.tsx");
  const content = `
    function App() {
      const title = "Hello";
      return <Card title={title} />;
    }
  `;
  fs.writeFileSync(testFile, content);
  const sourceFile = analyzer.getSourceFile(testFile);
  const usage = analyzer.findPropUsage(sourceFile!, "Card", "title");
  assertEqual(usage?.value, "title");
});

test("Find boolean shorthand prop", () => {
  const testFile = path.join(tempDir, "Usage3.tsx");
  const content = `
    function App() {
      return <Button disabled />;
    }
  `;
  fs.writeFileSync(testFile, content);
  const sourceFile = analyzer.getSourceFile(testFile);
  const usage = analyzer.findPropUsage(sourceFile!, "Button", "disabled");
  assertEqual(usage?.value, "true");
});

test("Detect spread operator", () => {
  const testFile = path.join(tempDir, "Usage4.tsx");
  const content = `
    function Wrapper(props) {
      return <Button {...props} />;
    }
  `;
  fs.writeFileSync(testFile, content);
  const sourceFile = analyzer.getSourceFile(testFile);
  const usage = analyzer.findPropUsage(sourceFile!, "Button", "anyProp");
  assertEqual(usage?.value, "{...spread}");
});

test("Find prop in self-closing element", () => {
  const testFile = path.join(tempDir, "Usage5.tsx");
  const content = `
    function App() {
      return <Input placeholder="Enter text" />;
    }
  `;
  fs.writeFileSync(testFile, content);
  const sourceFile = analyzer.getSourceFile(testFile);
  const usage = analyzer.findPropUsage(sourceFile!, "Input", "placeholder");
  assertEqual(usage?.value, '"Enter text"');
});

test("Find prop in opening element", () => {
  const testFile = path.join(tempDir, "Usage6.tsx");
  const content = `
    function App() {
      return <Card title="Test">Content</Card>;
    }
  `;
  fs.writeFileSync(testFile, content);
  const sourceFile = analyzer.getSourceFile(testFile);
  const usage = analyzer.findPropUsage(sourceFile!, "Card", "title");
  assertEqual(usage?.value, '"Test"');
});

// ============================================================================
// Test Category 6: Edge Cases
// ============================================================================
console.log("\n--- Edge Cases ---\n");

test("Ignore non-component functions (lowercase)", () => {
  const testFile = path.join(tempDir, "Utils.ts");
  fs.writeFileSync(testFile, `
    function calculateTotal(items) {
      return items.reduce((sum, item) => sum + item, 0);
    }
    
    const formatDate = (date) => date.toISOString();
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 0);
});

test("Multiple components in same file", () => {
  const testFile = path.join(tempDir, "Multi.tsx");
  fs.writeFileSync(testFile, `
    function Header({ title }) {
      return <h1>{title}</h1>;
    }
    
    const Footer = ({ copyright }) => {
      return <footer>{copyright}</footer>;
    };
    
    function Layout({ children }) {
      return <div>{children}</div>;
    }
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 3);
  const names = components.map((c) => c.name).sort();
  assertEqual(names, ["Footer", "Header", "Layout"]);
});

test("Component with no props", () => {
  const testFile = path.join(tempDir, "NoProps.tsx");
  fs.writeFileSync(testFile, `
    function Divider() {
      return <hr />;
    }
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].props, []);
});

test("Component with rest props", () => {
  const testFile = path.join(tempDir, "Rest.tsx");
  fs.writeFileSync(testFile, `
    function Button({ label, ...rest }) {
      return <button {...rest}>{label}</button>;
    }
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertIncludes(components[0].props, "label");
  assertIncludes(components[0].props, "rest");
});

test("In-memory document text (unsaved changes)", () => {
  const testFile = path.join(tempDir, "InMemory.tsx");
  fs.writeFileSync(testFile, `
    function OldComponent({ old }) {
      return <div>{old}</div>;
    }
  `);
  
  // First analyze from disk
  let components = analyzer.analyzeFile(testFile);
  assertEqual(components[0].name, "OldComponent");
  
  // Now analyze with in-memory content (simulating unsaved changes)
  const newContent = `
    function NewComponent({ newProp, anotherProp }) {
      return <div>{newProp}</div>;
    }
  `;
  components = analyzer.analyzeFile(testFile, newContent);
  assertEqual(components[0].name, "NewComponent");
  assertEqual(components[0].props.sort(), ["anotherProp", "newProp"]);
});

// ============================================================================
// Test Category 7: Next.js / Remix Patterns
// ============================================================================
console.log("\n--- Next.js / Remix Patterns ---\n");

test("Next.js page component with params", () => {
  const testFile = path.join(tempDir, "NextPage.tsx");
  fs.writeFileSync(testFile, `
    export default function Page({ params, searchParams }) {
      return <div>{params.id}</div>;
    }
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].name, "Page");
  assertEqual(components[0].props.sort(), ["params", "searchParams"]);
});

test("Remix loader data pattern", () => {
  const testFile = path.join(tempDir, "RemixRoute.tsx");
  fs.writeFileSync(testFile, `
    export default function UserRoute() {
      return <div>Content</div>;
    }
  `);
  const components = analyzer.analyzeFile(testFile);
  assertEqual(components.length, 1);
  assertEqual(components[0].name, "UserRoute");
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
