# PropFlow - Installation and Testing Guide

## Quick Start

### Prerequisites

- Node.js 18+ and npm
- Visual Studio Code 1.85.0+
- Git (optional)

### Setup and Build

1. **Extract or clone the project files**

```bash
cd propflow
```

2. **Install dependencies**

```bash
npm install
```

3. **Compile TypeScript**

```bash
npm run compile
```

4. **Run tests**

```bash
npm test
```

5. **Package the extension**

```bash
npm run package
```

This will create `propflow-0.0.1.vsix`

### Installation in VS Code

**Option 1: Command Line**

```bash
code --install-extension propflow-0.0.1.vsix
```

**Option 2: VS Code UI**

1. Open VS Code
2. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
3. Type "Extensions: Install from VSIX"
4. Select `propflow-0.0.1.vsix`

## Testing the Extension

### Unit Tests

Run all unit tests:

```bash
npm test
```

This executes:

- `test/extension.test.ts` - Extension activation tests
- `test/astAnalyzer.test.ts` - AST parsing tests
- `test/graphBuilder.test.ts` - Prop tracing tests

### Manual Testing

1. **Create a test React project** (or use existing)

2. **Create test files:**

`Button.tsx`:

```typescript
import React from 'react';

interface ButtonProps {
  label: string;
  onClick: () => void;
}

export function Button({ label, onClick }: ButtonProps) {
  return <button onClick={onClick}>{label}</button>;
}
```

`Card.tsx`:

```typescript
import React from 'react';
import { Button } from './Button';

interface CardProps {
  title: string;
  buttonLabel: string;
}

export function Card({ title, buttonLabel }: CardProps) {
  return (
    <div>
      <h2>{title}</h2>
      <Button label={buttonLabel} onClick={() => {}} />
    </div>
  );
}
```

`App.tsx`:

```typescript
import React from 'react';
import { Card } from './Card';

export function App() {
  return <Card title="Welcome" buttonLabel="Click Me" />;
}
```

3. **Test PropFlow features:**

   a. **Show Lineage:**
   - Open `Button.tsx`
   - Place cursor on `label` in the function parameters
   - Press `Ctrl+Shift+P`
   - Run "PropFlow: Show Lineage"
   - Check the "PropFlow Lineage" panel in the sidebar

   b. **Trace Upstream:**
   - Open `Button.tsx`
   - Place cursor on `label`
   - Press `Ctrl+Shift+P`
   - Run "PropFlow: Trace Prop Upstream"
   - Should navigate to `Card.tsx`

   c. **CodeLens:**
   - Look for "⬆ Trace Props" above component definitions
   - Click to show lineage

## Test Results Expected

### Unit Test Suite

```
Extension Test Suite
  ✓ Extension should be present
  ✓ Should register propflow.showLineage command
  ✓ Should register propflow.traceProp command
  ✓ Extension should activate
  ✓ Should handle command execution without active editor

ASTAnalyzer Test Suite
  ✓ Should extract props from function component with destructuring
  ✓ Should extract props from arrow function component
  ✓ Should find prop usage in JSX
  ✓ Should handle prop spread attributes
  ✓ Should ignore non-component functions
  ✓ Should extract multiple components from same file

GraphBuilder Test Suite
  ✓ Should create GraphBuilder instance
  ✓ Should handle buildPropChain with basic parameters
  ✓ Should initialize with correct default values
  ✓ Should handle empty prop name
  ✓ Should not exceed max depth

15 passing (1.24s)
```

## Troubleshooting

### Tests fail with "Cannot find module"

```bash
npm install
npm run compile
```

### VS Code doesn't recognize the extension

- Ensure VS Code version is 1.85.0+
- Reload VS Code after installation
- Check Output panel for errors

### "Trace not found" error

- Ensure you're testing with actual React files
- Check that components are properly exported/imported
- Verify file extensions (.tsx, .ts, .jsx, .js)

### Performance issues

- First trace may be slower (indexing)
- Large projects (10k+ files) may take longer
- Subsequent traces are faster

## File Structure

```
propflow/
├── src/
│   ├── extension.ts           # Main entry point
│   ├── astAnalyzer.ts         # AST parsing
│   ├── graphBuilder.ts        # Prop chain building
│   ├── treeViewProvider.ts    # UI components
│   └── types.ts               # Type definitions
├── test/
│   ├── suite/
│   │   └── index.ts          # Test suite setup
│   ├── extension.test.ts     # Extension tests
│   ├── astAnalyzer.test.ts   # AST tests
│   ├── graphBuilder.test.ts  # Graph tests
│   └── runTest.ts            # Test runner
├── out/                       # Compiled JavaScript (auto-generated)
├── package.json              # Extension manifest
├── tsconfig.json             # TypeScript config
├── .vscodeignore            # Package exclusions
└── README.md                # Documentation
```

## Development Commands

| Command           | Description                      |
| ----------------- | -------------------------------- |
| `npm install`     | Install dependencies             |
| `npm run compile` | Compile TypeScript to JavaScript |
| `npm run watch`   | Compile in watch mode            |
| `npm test`        | Run all tests                    |
| `npm run package` | Create VSIX package              |

## Next Steps

After successful installation:

1. Open a React/TypeScript project
2. Try tracing props in your components
3. Explore the PropFlow Lineage sidebar
4. Use CodeLens for quick navigation

## Support

For issues or questions:

- Check the Output panel (View → Output → PropFlow)
- Review console logs (Help → Toggle Developer Tools)
- Consult README.md for detailed documentation
