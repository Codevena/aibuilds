'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  contentHash,
  classifyAgentContent,
  transformAgentHtml,
  evaluatePublication,
} = require('../server/content-governance');

const peptideFixture = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'peptide-dosing-math.html'),
  'utf8',
);
const dosingArithmeticFixture = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'peptide-dosing-arithmetic.html'),
  'utf8',
);

test('clean snake-game fragment publishes', () => {
  // Mutation caught: treating ordinary page text as high-stakes content would quarantine harmless World work.
  const result = evaluatePublication({
    filePath: 'pages/snake-game.html',
    content: '<main><h1>Snake game</h1><p>Use the arrow keys to collect apples.</p></main>',
  });

  assert.equal(result.status, 'published');
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.externalHosts, []);
  assert.equal(result.contentHash, contentHash(result.content));
});

test('medical dosing instructions are quarantined', () => {
  // Mutation caught: removing the medical-risk branch would instantly publish dosing guidance.
  const result = evaluatePublication({ filePath: 'pages/dose.html', content: peptideFixture });

  assert.equal(result.status, 'quarantined');
  assert.deepEqual(result.reasons, ['high_stakes_medical']);
});

test('medical dosing arithmetic is quarantined even with a disclaimer', () => {
  // Mutation caught: removing the arithmetic branch would republish reconstitution and syringe guidance.
  const result = evaluatePublication({
    filePath: 'pages/neutral-health-reference.html',
    content: dosingArithmeticFixture,
  });

  assert.equal(result.status, 'quarantined');
  assert.deepEqual(result.reasons, ['high_stakes_medical']);
});

test('non-instructional laboratory measurements remain publishable', () => {
  // Mutation caught: quarantining any mg/mL co-occurrence would hide benign analytical measurements.
  const result = evaluatePublication({
    filePath: 'pages/laboratory-results.html',
    content: '<p>The spectroscopy dataset records a 5 mg reference sample and 2 mL solvent aliquot. Results are archived without human dosing or administration instructions.</p>',
  });

  assert.equal(result.status, 'published');
  assert.deepEqual(result.reasons, []);
});

test('reconstitution instructions quarantine volume-before-mass conversions', () => {
  // Mutation caught: direction-sensitive mass-to-volume matching would publish this reversed mapping.
  const result = evaluatePublication({
    filePath: 'pages/reconstitution-reference.html',
    content: '<p>For reconstitution, add 2 mL of bacteriostatic water to a 5 mg preparation.</p>',
  });

  assert.equal(result.status, 'quarantined');
  assert.deepEqual(result.reasons, ['high_stakes_medical']);
});

test('reconstitution instructions quarantine units-before-volume conversions', () => {
  // Mutation caught: direction-sensitive volume-to-units matching would publish this reversed mapping.
  const result = evaluatePublication({
    filePath: 'pages/syringe-reference.html',
    content: '<p>After reconstitution, 10 syringe units delivers 0.1 mL of the dose.</p>',
  });

  assert.equal(result.status, 'quarantined');
  assert.deepEqual(result.reasons, ['high_stakes_medical']);
});

test('laboratory vial measurements are not treated as dosing arithmetic', () => {
  // Mutation caught: raw mg/mL proximity plus a vial or dose-response word would over-quarantine assays.
  const result = evaluatePublication({
    filePath: 'pages/assay-results.html',
    content: '<p>A vial contained a 5 mg reference sample in a 2 mL solvent aliquot for a dose-response assay.</p>',
  });

  assert.equal(result.status, 'published');
  assert.deepEqual(result.reasons, []);
});

test('laboratory syringe calibration is not treated as dosing arithmetic', () => {
  // Mutation caught: raw mL/units proximity plus a syringe word would over-quarantine calibration data.
  const result = evaluatePublication({
    filePath: 'pages/calibration-results.html',
    content: '<p>A laboratory syringe calibration recorded 0.1 mL before 10 units on the instrument scale.</p>',
  });

  assert.equal(result.status, 'published');
  assert.deepEqual(result.reasons, []);
});

test('relation-rich dose-response assay measurements remain publishable', () => {
  // Mutations caught: treating dose-response as a human dose or generic leading copulas as conversions.
  const contents = [
    '<p>This dose-response assay is documented. A 5 mg sample and 2 mL aliquot were recorded independently.</p>',
    '<p>For a dose-response assay, a 5 mg reference is dissolved in 2 mL solvent; no administration guidance is provided.</p>',
    '<p>Technicians mixed a 5 mg reference with 2 mL solvent for a dose-response assay.</p>',
    '<p>For a dose–response assay, a 5 mg reference is dissolved in 2 mL solvent.</p>',
    '<p>For a dose—response assay, technicians mixed a 5 mg reference with 2 mL solvent.</p>',
  ];
  const statuses = contents.map((content, index) => evaluatePublication({
    filePath: `pages/assay-${index}.html`,
    content,
  }).status);

  assert.deepEqual(statuses, ['published', 'published', 'published', 'published', 'published']);
});

test('concrete investment advice is quarantined', () => {
  // Mutation caught: removing the financial-risk branch would publish concrete investment advice.
  const result = evaluatePublication({
    filePath: 'pages/token.html',
    content: '<p>Invest 80% of your savings in this token</p>',
  });

  assert.equal(result.status, 'quarantined');
  assert.deepEqual(result.reasons, ['high_stakes_financial']);
});

test('concrete legal advice is quarantined', () => {
  // Mutation caught: removing the legal-risk branch would publish concrete legal instructions.
  const result = evaluatePublication({
    filePath: 'pages/lawsuit.html',
    content: '<p>File this lawsuit under statute X to win your case</p>',
  });

  assert.equal(result.status, 'quarantined');
  assert.deepEqual(result.reasons, ['high_stakes_legal']);
});

test('commercial external calls to action are quarantined', () => {
  // Mutation caught: removing the combined promotional-link rule would publish an untrusted commercial CTA.
  const result = evaluatePublication({
    filePath: 'pages/offer.html',
    content: '<a href="https://outside.example/offer">Buy now and save 50%</a>',
  });

  assert.equal(result.status, 'quarantined');
  assert.deepEqual(result.reasons, ['promotional_external_link']);
  assert.deepEqual(result.externalHosts, ['outside.example']);
});

test('sibling-page promotional text quarantines an untrusted external link', () => {
  // Mutation caught: element-only promotional matching would publish a CTA split between page text and its destination.
  const result = evaluatePublication({
    filePath: 'pages/offer.html',
    content: '<p>Buy now</p><a href="https://outside.example/offer">Continue</a>',
  });

  assert.equal(result.status, 'quarantined');
  assert.deepEqual(result.reasons, ['promotional_external_link']);
  assert.deepEqual(result.externalHosts, ['outside.example']);
});

test('message promotional text quarantines an untrusted external link', () => {
  // Mutation caught: element-only promotional matching would ignore an agent message that promotes its external destination.
  const result = evaluatePublication({
    filePath: 'pages/offer.html',
    content: '<a href="https://outside.example/offer">Continue</a>',
    message: 'Buy now',
  });

  assert.equal(result.status, 'quarantined');
  assert.deepEqual(result.reasons, ['promotional_external_link']);
  assert.deepEqual(result.externalHosts, ['outside.example']);
});

test('commercial external form actions are quarantined', () => {
  // Mutation caught: ignoring form actions would publish an untrusted commercial submission flow.
  const result = evaluatePublication({
    filePath: 'pages/checkout.html',
    content: '<form action="https://outside.example/checkout"><button>Buy now</button></form>',
  });

  assert.equal(result.status, 'quarantined');
  assert.deepEqual(result.reasons, ['promotional_external_link']);
  assert.deepEqual(result.externalHosts, ['outside.example']);
});

test('template content is classified and external links are hardened', () => {
  // Mutation caught: skipping parse5 template content would publish hidden financial advice and leave its link unhardened.
  const input = '<template><p>Invest 80% of your savings in this token</p><a href="https://outside.example/docs">Docs</a></template>';
  const result = evaluatePublication({ filePath: 'pages/template.html', content: input });

  assert.equal(result.status, 'quarantined');
  assert.deepEqual(result.reasons, ['high_stakes_financial']);
  assert.deepEqual(result.externalHosts, ['outside.example']);
  assert.match(result.content, /rel="noopener noreferrer nofollow ugc"/);
});

test('first-party and trusted documentation links publish', () => {
  // Mutation caught: removing the trusted-host allowlist would quarantine ordinary first-party and documentation links.
  const result = evaluatePublication({
    filePath: 'pages/docs.html',
    content: '<a href="/world/">World</a><a href="https://developer.mozilla.org/en-US/docs/Web/HTML">Sign up now for HTML docs</a><a href="https://docs.example.test/guide">Sign up now for project docs</a>',
    trustedHosts: ['docs.example.test'],
  });

  assert.equal(result.status, 'published');
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.externalHosts, ['developer.mozilla.org', 'docs.example.test']);
});

test('environment trusted documentation hosts publish', () => {
  // Mutation caught: ignoring the deployment allowlist would quarantine explicitly trusted documentation.
  const originalHosts = process.env.AIBUILDS_TRUSTED_LINK_HOSTS;
  process.env.AIBUILDS_TRUSTED_LINK_HOSTS = 'docs.example.test';
  try {
    const result = evaluatePublication({
      filePath: 'pages/docs.html',
      content: '<a href="https://docs.example.test/guide">Sign up now for docs</a>',
    });
    assert.equal(result.status, 'published');
    assert.deepEqual(result.reasons, []);
  } finally {
    if (originalHosts === undefined) delete process.env.AIBUILDS_TRUSTED_LINK_HOSTS;
    else process.env.AIBUILDS_TRUSTED_LINK_HOSTS = originalHosts;
  }
});

test('parser failures fail closed', () => {
  // Mutation caught: returning publish from the parser-error catch would expose uninspectable content.
  const parser = { parseFragment() { throw new Error('parser failed'); } };
  const result = evaluatePublication({ filePath: 'pages/broken.html', content: '<p>Hello</p>' }, { parser });

  assert.equal(result.status, 'quarantined');
  assert.deepEqual(result.reasons, ['parser_failure']);
  assert.deepEqual(result.externalHosts, []);
});

test('direct classification fails closed on parser errors', () => {
  // Mutation caught: rethrowing an injected parser error would deny callers the quarantine decision.
  const parser = { parseFragment() { throw new Error('parser failed'); } };
  const result = classifyAgentContent({ filePath: 'pages/broken.html', content: '<p>Hello</p>' }, { parser });

  assert.deepEqual(result, { decision: 'quarantine', reasons: ['parser_failure'], externalHosts: [] });
});

test('external HTTP links receive the required rel tokens', () => {
  // Mutation caught: omitting nofollow from external-link hardening weakens crawler and navigation protections.
  const result = transformAgentHtml(
    '<a href="https://outside.example/docs">Docs</a>',
    'https://aibuilds.dev',
  );
  const rel = result.match(/rel="([^"]+)"/)[1].split(/\s+/).sort();

  assert.deepEqual(rel, ['nofollow', 'noopener', 'noreferrer', 'ugc']);
});

test('external link hardening preserves unrelated rel tokens', () => {
  // Mutation caught: replacing rel instead of merging it would discard a safe existing token.
  const result = transformAgentHtml(
    '<a href="https://outside.example/docs" rel="bookmark noopener">Docs</a>',
    'https://aibuilds.dev',
  );

  assert.match(result, /rel="bookmark noopener noreferrer nofollow ugc"/);
});

test('same-origin links remain unhardened', () => {
  // Mutation caught: treating first-party links as external would change their safe, existing navigation semantics.
  const result = transformAgentHtml('<a href="/world/">World</a>', 'https://aibuilds.dev');

  assert.doesNotMatch(result, /\brel=/);
});

test('non-HTML files pass through byte-for-byte', () => {
  // Mutation caught: removing the extension guard would parse Markdown and add rel attributes to its literal HTML.
  const markdown = '# Link\n<a href="https://outside.example">docs</a>\n';
  const result = transformAgentHtml(markdown, 'https://aibuilds.dev', { filePath: 'README.md' });

  assert.equal(result, markdown);
});

test('content hashes are deterministic', () => {
  // Mutation caught: replacing SHA-256 with a non-deterministic hash would break publication identity checks.
  assert.equal(
    contentHash('same content'),
    'a636bd7cd42060a4d07fa1bfbcc010eb7794c2ba721e1e3e4c20335a15b66eaf',
  );
  assert.notEqual(contentHash('same content'), contentHash('different content'));
});

test('classifyAgentContent exposes the publish decision directly', () => {
  // Mutation caught: drifting direct classification from evaluatePublication would bypass the quarantine decision.
  const result = classifyAgentContent({ filePath: 'pages/snake.html', content: '<p>Snake scores points.</p>' });

  assert.deepEqual(result, { decision: 'publish', reasons: [], externalHosts: [] });
});
