'use strict';

const fs = require('fs');
const path = require('path');

const outputPath = process.argv[2];
if (!outputPath) {
  throw new Error('usage: node scripts/generate-copy-manifest.cjs <output-path>');
}

const toolsRoot = process.env.AIBUILDS_COPY_TOOLS_ROOT;
const ts = toolsRoot
  ? require(path.join(toolsRoot, 'node_modules/typescript/lib/typescript.js'))
  : require('typescript');
const parse5 = toolsRoot
  ? require(path.join(toolsRoot, 'node_modules/parse5/dist/cjs/index.js'))
  : require('parse5');

const files = [
  'public/landing.html',
  'public/index.html',
  'public/js/app.js',
  'world/layout.html',
  'world/index.html',
];

const rows = [];

function clean(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function add(file, line, kind, value) {
  const text = clean(value);
  if (text) rows.push(`${file}:${line}\t${kind}\t${JSON.stringify(text)}`);
}

function lineFor(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

function collectJavaScript(file, source, lineOffset = 0) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

  function visit(node) {
    if (ts.isImportDeclaration(node)) return;

    const parent = node.parent;
    const isClassNameValue = parent && (
      (ts.isPropertyAssignment(parent) && parent.name && parent.name.getText(sf) === 'className') ||
      (ts.isJsxAttribute(parent) && parent.name && parent.name.getText(sf) === 'className')
    );
    if (isClassNameValue) return;

    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 + lineOffset;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      add(file, line, 'js-string', node.text);
    } else if (ts.isTemplateExpression(node)) {
      add(file, line, 'js-template', node.head.text);
      for (const span of node.templateSpans) add(file, line, 'js-template', span.literal.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
}

function collectHtml(file, source) {
  const doc = parse5.parse(source, { sourceCodeLocationInfo: true });
  const accessibleAttrs = new Set(['alt', 'aria-label', 'placeholder', 'title', 'data-tooltip']);
  const skipTextParents = new Set(['style', 'svg']);

  function walk(node, parentTag = '') {
    const tag = node.tagName || parentTag;
    const loc = node.sourceCodeLocation;

    if (node.nodeName === '#text' && !skipTextParents.has(parentTag)) {
      const offset = loc && typeof loc.startOffset === 'number' ? loc.startOffset : 0;
      add(file, lineFor(source, offset), parentTag === 'script' ? 'inline-script-text' : 'html-text', node.value);
    }

    if (node.attrs && loc) {
      for (const attr of node.attrs) {
        if (accessibleAttrs.has(attr.name)) add(file, loc.startLine || 1, `html-${attr.name}`, attr.value);
      }
    }

    if (node.tagName === 'script') {
      const textNode = (node.childNodes || []).find((child) => child.nodeName === '#text');
      if (textNode && textNode.value.trim()) {
        const startLine = textNode.sourceCodeLocation?.startLine || loc?.startLine || 1;
        collectJavaScript(file, textNode.value, startLine - 1);
      }
      return;
    }

    for (const child of node.childNodes || []) walk(child, tag);
  }

  walk(doc);
}

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.html')) collectHtml(file, source);
  else collectJavaScript(file, source);
}

const manifest = rows.join('\n') + '\n';
fs.writeFileSync(outputPath, manifest);
process.stdout.write(JSON.stringify({ outputPath, entries: rows.length }));
