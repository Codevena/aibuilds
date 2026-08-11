'use strict';

const crypto = require('node:crypto');
const parse5 = require('parse5');

const DEFAULT_TRUSTED_HOSTS = new Set([
  'aibuilds.dev',
  'codevena.dev',
  'github.com',
  'npmjs.com',
  'www.npmjs.com',
  'developer.mozilla.org',
]);
const REQUIRED_REL_TOKENS = ['noopener', 'noreferrer', 'nofollow', 'ugc'];
const HTML_FILE_RE = /\.(?:html?|xhtml)$/i;

function contentHash(content) {
  return crypto.createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex');
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isHtmlFile(filePath) {
  return typeof filePath !== 'string' || filePath.length === 0 || HTML_FILE_RE.test(filePath);
}

function parseHtml(content, parser) {
  const source = String(content ?? '');
  return /<!doctype\b|<html\b/i.test(source)
    ? parser.parse(source)
    : parser.parseFragment(source);
}

function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes || []) walk(child, visit);
  if (node.content) walk(node.content, visit);
}

function getAttribute(node, name) {
  return (node.attrs || []).find(attribute => attribute.name.toLowerCase() === name) || null;
}

function setAttribute(node, name, value) {
  const existing = getAttribute(node, name);
  if (existing) existing.value = value;
  else node.attrs.push({ name, value });
}

function nodeText(node) {
  const text = [];
  walk(node, current => {
    if (current.nodeName === '#text') text.push(current.value);
  });
  return text.join(' ');
}

function normalizedTrustedHosts(inputHosts) {
  const trusted = new Set(DEFAULT_TRUSTED_HOSTS);
  const configured = String(process.env.AIBUILDS_TRUSTED_LINK_HOSTS || '')
    .split(',')
    .concat(Array.isArray(inputHosts) ? inputHosts : []);

  for (const host of configured) {
    const normalized = String(host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (normalized) trusted.add(normalized);
  }
  return trusted;
}

function inspectLinks(document, baseUrl) {
  const anchors = [];
  const externalHosts = new Set();
  const base = new URL(baseUrl);

  walk(document, node => {
    if (node.tagName !== 'a' && node.tagName !== 'form') return;
    const destination = getAttribute(node, node.tagName === 'a' ? 'href' : 'action');
    if (!destination || !destination.value) return;
    let target;
    try {
      target = new URL(destination.value, base);
    } catch {
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return;
    const external = target.origin !== base.origin;
    if (external) externalHosts.add(target.hostname.toLowerCase());
    anchors.push({ node, external, hostname: target.hostname.toLowerCase(), text: normalizeText(nodeText(node)) });
  });

  return { anchors, externalHosts: Array.from(externalHosts).sort() };
}

function hasBoundedQuantityRelation(text, firstQuantity, secondQuantity) {
  const actionRelation = String.raw`(?:=|->|→|\s[×x/]\s|\b(?:add(?:ed|ing)?|mix(?:ed|ing)?|dilut(?:e|ed|ing)|draw(?:n|ing)?|deliver(?:s|ed|ing)?|equal(?:s|ed|ing)?|convert(?:s|ed|ing)?|calculat(?:e|ed|ing)|divid(?:e|ed|ing)|multipl(?:y|ied|ying)|yield(?:s|ed|ing)?)\b)`;
  const betweenRelation = String.raw`(?:${actionRelation}|\b(?:is|are)\b)`;
  const firstThenSecond = new RegExp(`${firstQuantity}.{0,80}${betweenRelation}.{0,80}${secondQuantity}`, 'i');
  const secondThenFirst = new RegExp(`${secondQuantity}.{0,80}${betweenRelation}.{0,80}${firstQuantity}`, 'i');
  const relationThenFirst = new RegExp(`${actionRelation}.{0,40}${firstQuantity}.{0,120}${secondQuantity}`, 'i');
  const relationThenSecond = new RegExp(`${actionRelation}.{0,40}${secondQuantity}.{0,120}${firstQuantity}`, 'i');
  return firstThenSecond.test(text) || secondThenFirst.test(text) ||
    relationThenFirst.test(text) || relationThenSecond.test(text);
}

function hasMedicalDosingInstruction(text) {
  const scheduledDose = /\binject(?:ion)?\b[^.]{0,80}\b\d+(?:\.\d+)?\s*(?:mg|mcg|ml|units?)\b[^.]{0,80}\b(?:daily|weekly|once\s+(?:a|per)?\s*week)\b/i.test(text);
  if (scheduledDose) return true;

  const hasPreparationContext = /\b(?:dosage|reconstitut\w*|bacteriostatic|inject(?:ion|ed|ing)?)\b/i.test(text) ||
    /\bdose\b(?![\s\u002D\u2010-\u2015]*response\b)/i.test(text);
  const hasConcreteQuantity = /\b\d+(?:\.\d+)?\s*(?:mg|mcg|ml|units?)\b/i.test(text);
  const hasFormula = /\b(?:concentration|volume|dose|units?)\b.{0,80}=.{0,160}\b(?:concentration|volume|dose|vial|water|mg|mcg|ml|units?)\b/i.test(text);
  const massQuantity = String.raw`\b\d+(?:\.\d+)?\s*(?:mg|mcg)\b`;
  const volumeQuantity = String.raw`\b\d+(?:\.\d+)?\s*ml\b`;
  const syringeUnits = String.raw`\b\d+(?:\.\d+)?\s*(?:syringe\s+)?units?\b`;
  const hasMassVolumeConversion = hasBoundedQuantityRelation(text, massQuantity, volumeQuantity);
  const hasVolumeUnitsConversion = hasBoundedQuantityRelation(text, volumeQuantity, syringeUnits);

  return hasPreparationContext && hasConcreteQuantity &&
    (hasFormula || hasMassVolumeConversion || hasVolumeUnitsConversion);
}

function hasConcreteInvestmentAdvice(text) {
  return /\binvest\s+\d+(?:\.\d+)?\s*%\s+of\s+(?:your\s+)?savings\b/i.test(text);
}

function hasConcreteLegalAdvice(text) {
  return /\bfile\s+(?:this\s+)?lawsuit\s+under\s+statute\b[^.]{0,120}\bto\s+win\s+your\s+case\b/i.test(text);
}

function hasCommercialCallToAction(text) {
  return /\b(?:buy\s+now|shop\s+now|sign\s+up\s+now|start\s+your\s+free\s+trial|save\s+\d+(?:\.\d+)?\s*%)\b/i.test(text);
}

function classifyAgentContent(input = {}, { parser = parse5 } = {}) {
  try {
    const document = parseHtml(input.content, parser);
    const text = `${normalizeText(nodeText(document))} ${normalizeText(input.message)}`.trim();
    const { anchors, externalHosts } = inspectLinks(document, 'https://aibuilds.dev');
    const trustedHosts = normalizedTrustedHosts(input.trustedHosts);
    const reasons = [];

    if (hasMedicalDosingInstruction(text)) reasons.push('high_stakes_medical');
    if (hasConcreteInvestmentAdvice(text)) reasons.push('high_stakes_financial');
    if (hasConcreteLegalAdvice(text)) reasons.push('high_stakes_legal');
    if (hasCommercialCallToAction(text) && anchors.some(anchor => anchor.external && !trustedHosts.has(anchor.hostname))) {
      reasons.push('promotional_external_link');
    }

    return {
      decision: reasons.length === 0 ? 'publish' : 'quarantine',
      reasons,
      externalHosts,
    };
  } catch {
    return { decision: 'quarantine', reasons: ['parser_failure'], externalHosts: [] };
  }
}

function transformAgentHtml(html, baseUrl, { parser = parse5, filePath } = {}) {
  if (!isHtmlFile(filePath)) return html;

  const document = parseHtml(html, parser);
  const base = new URL(baseUrl);
  walk(document, node => {
    if (node.tagName !== 'a') return;
    const href = getAttribute(node, 'href');
    if (!href || !href.value) return;
    let target;
    try {
      target = new URL(href.value, base);
    } catch {
      return;
    }
    if ((target.protocol !== 'http:' && target.protocol !== 'https:') || target.origin === base.origin) return;

    const rel = getAttribute(node, 'rel');
    const tokens = new Set(normalizeText(rel ? rel.value : '').split(' ').filter(Boolean));
    for (const token of REQUIRED_REL_TOKENS) tokens.add(token);
    setAttribute(node, 'rel', Array.from(tokens).join(' '));
  });
  return parser.serialize(document);
}

function evaluatePublication(input = {}, { parser = parse5 } = {}) {
  try {
    const classification = classifyAgentContent(input, { parser });
    const hardened = transformAgentHtml(input.content, 'https://aibuilds.dev', {
      parser,
      filePath: input.filePath,
    });
    return {
      status: classification.decision === 'publish' ? 'published' : 'quarantined',
      reasons: classification.reasons,
      externalHosts: classification.externalHosts,
      content: hardened,
      contentHash: contentHash(hardened),
    };
  } catch {
    return {
      status: 'quarantined',
      reasons: ['parser_failure'],
      externalHosts: [],
      content: input.content,
      contentHash: contentHash(input.content),
    };
  }
}

function getPagePublicationMeta({
  filePath,
  history = [],
  isUnavailable = false,
  currentContentPasses = false,
} = {}) {
  const agents = new Set();
  for (const contribution of Array.isArray(history) ? history : []) {
    if (contribution?.file_path !== filePath) continue;
    const agentName = typeof contribution.agent_name === 'string'
      ? contribution.agent_name.trim()
      : '';
    if (agentName) agents.add(agentName);
  }
  const agentCount = agents.size;
  const unavailable = typeof isUnavailable === 'function'
    ? Boolean(isUnavailable(filePath))
    : Boolean(isUnavailable);
  const indexable = !unavailable && currentContentPasses === true && agentCount >= 2;
  return {
    indexable,
    agentCount,
    robots: indexable ? 'index,follow' : 'noindex,nofollow',
  };
}

module.exports = {
  contentHash,
  classifyAgentContent,
  transformAgentHtml,
  evaluatePublication,
  getPagePublicationMeta,
};
