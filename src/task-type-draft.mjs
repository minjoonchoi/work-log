import fs from 'node:fs';
import path from 'node:path';
import { ROOT, assert } from './shared.mjs';
import { validateSchema } from './schema.mjs';

const inputSchema = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/inputs/task-type-draft.schema.json'), 'utf8'));
const outputSchema = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/task-type-draft.schema.json'), 'utf8'));
const headings = ['목적', '입력', '범위', '수행 절차', '완료 기준'];
const nameKey = value => value.normalize('NFC').trim().toLowerCase();
const meaningful = value => /[\p{L}\p{N}]/u.test(value);

export function validateTaskTypeDraftInput(input) {
  validateSchema(inputSchema, input, '작업 유형 초안 입력');
  assert(meaningful(input.request), '작업 유형 초안 요청에는 구체적인 업무 설명이 필요합니다.');
  for (const [key, label] of [['templates', '템플릿'], ['existing_tasks', '기존 업무']]) {
    assert(new Set(input[key].map(value => value.id)).size === input[key].length, `${label} ID가 중복되었습니다.`);
  }
  return input;
}

function instructionSections(instruction) {
  const text = instruction.replace(/\r\n?/g, '\n');
  const found = [];
  let offset = 0, fence = null;
  for (const line of text.split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
    } else if (!fence) {
      const heading = line.match(/^##[ \t]+([^\n]+?)[ \t]*$/);
      if (heading) found.push({ title: heading[1], start: offset, body: offset + line.length + 1 });
    }
    offset += line.length + 1;
  }
  assert(!fence, '작업 지시문의 코드 블록이 닫히지 않았습니다.');
  assert(found.length === headings.length && found.every((section, index) => section.title === headings[index]),
    `작업 지시문은 ${headings.join(' / ')} Markdown 구역을 이 순서로 한 번씩 포함해야 합니다.`);
  const sections = Object.fromEntries(found.map((section, index) => [section.title, text.slice(section.body, found[index + 1]?.start).trim()]));
  assert(Object.values(sections).every(meaningful), '작업 지시문의 모든 Markdown 구역에 의미 있는 본문이 필요합니다.');
  return sections;
}

export function parseTaskTypeDraft(text, input) {
  validateTaskTypeDraftInput(input);
  const value = validateSchema(outputSchema, JSON.parse(text), '작업 유형 초안');
  const template = input.templates.find(candidate => candidate.id === value.template_id);
  assert(template, '작업 유형 초안은 제공된 템플릿 하나를 선택해야 합니다.');
  assert(meaningful(value.label) && !/[\r\n]/.test(value.label) && meaningful(value.description), '작업 유형 이름과 용도는 의미 있는 텍스트여야 합니다.');
  const labels = [...input.existing_tasks, ...input.templates].map(task => nameKey(task.label));
  assert(!labels.includes(nameKey(value.label)), '같은 이름의 업무가 이미 있습니다. 다른 업무명을 작성하세요.');
  const terms = value.routing_terms.map(term => term.trim());
  assert(terms.every(meaningful) && new Set(terms).size === terms.length, '작업 유형 키워드는 의미 있는 중복 없는 표현이어야 합니다.');
  const sections = instructionSections(value.instruction), boundary = template.boundary;
  assert(sections['범위'].includes(boundary.deliverable)
    && boundary.excludes.every(item => sections['범위'].includes(`제외: ${item}`)), '작업 지시문의 범위에 템플릿 산출물과 모든 제외 조건을 보존해야 합니다.');
  return { template_id: value.template_id, label: value.label.trim(), description: value.description.trim(),
    routing_terms: terms, instruction: value.instruction };
}
