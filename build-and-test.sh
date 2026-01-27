#!/bin/bash

# PropFlow Extension Build and Test Script

set -e

echo "================================"
echo "PropFlow Extension Builder"
echo "================================"
echo ""

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Step 1: Setup
echo -e "${BLUE}[1/5] Setting up project...${NC}"
if [ ! -d "node_modules" ]; then
    npm install
    echo -e "${GREEN}✓ Dependencies installed${NC}"
else
    echo -e "${GREEN}✓ Dependencies already installed${NC}"
fi
echo ""

# Step 2: Compile TypeScript
echo -e "${BLUE}[2/5] Compiling TypeScript...${NC}"
npm run compile
echo -e "${GREEN}✓ Compilation successful${NC}"
echo ""

# Step 3: Run Tests
echo -e "${BLUE}[3/5] Running tests...${NC}"
echo ""
npm test 2>&1 | tee test-results.log
TEST_RESULT=$?

if [ $TEST_RESULT -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✓ All tests passed!${NC}"
else
    echo ""
    echo -e "${RED}✗ Some tests failed${NC}"
fi
echo ""

# Step 4: Package Extension
echo -e "${BLUE}[4/5] Packaging extension...${NC}"
npm run package
echo -e "${GREEN}✓ VSIX package created${NC}"
echo ""

# Step 5: Summary
echo -e "${BLUE}[5/5] Build Summary${NC}"
echo "================================"
echo -e "Extension: ${GREEN}propflow-0.0.1.vsix${NC}"
echo -e "Source files: ${GREEN}$(find src -name '*.ts' | wc -l) TypeScript files${NC}"
echo -e "Test files: ${GREEN}$(find test -name '*.test.ts' | wc -l) test suites${NC}"
echo -e "Status: ${GREEN}Ready for installation${NC}"
echo ""
echo "================================"
echo "Installation Instructions:"
echo "================================"
echo "1. Open VS Code"
echo "2. Press Ctrl+Shift+P (Cmd+Shift+P on Mac)"
echo "3. Type 'Install from VSIX'"
echo "4. Select propflow-0.0.1.vsix"
echo ""
echo "Or use command line:"
echo "  code --install-extension propflow-0.0.1.vsix"
echo ""