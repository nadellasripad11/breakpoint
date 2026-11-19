import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveMapping } from '../src/notionMapping.js';

const db = (...props) => ({ properties: props.map(([name, type]) => ({ name, type })) });

test('a typical homework database maps every column', () => {
  const m = deriveMapping(db(['Name', 'title'], ['Due', 'date'], ['Minutes', 'number'], ['Priority', 'select'], ['Status', 'status'], ['Subject', 'select']));
  assert.deepEqual(m, { title: 'Name', date: 'Due', duration: 'Minutes', priority: 'Priority', status: 'Status', category: 'Subject' });
});

test('with two date columns the deadline-looking one wins, not the first', () => {
  assert.equal(deriveMapping(db(['Name', 'title'], ['Started', 'date'], ['Finish by', 'date'])).date, 'Finish by');
  assert.equal(deriveMapping(db(['Name', 'title'], ['Start', 'date'], ['Deadline', 'date'])).date, 'Deadline');
});

test('with no obvious deadline name it falls back to the first date column', () => {
  assert.equal(deriveMapping(db(['Name', 'title'], ['When', 'date'], ['Other', 'date'])).date, 'When');
});

test('a select called Status is a status, never a priority', () => {
  const m = deriveMapping(db(['Name', 'title'], ['Status', 'select']));
  assert.equal(m.status, 'Status');
  assert.equal(m.priority, undefined);
});

test('columns that are not there are simply left out, so the server uses its defaults', () => {
  assert.deepEqual(deriveMapping(db(['Task', 'title'])), { title: 'Task' });
  assert.deepEqual(deriveMapping({}), {});
});

test('words like "Weekend" or "Standby" do not count as a deadline column', () => {
  assert.equal(deriveMapping(db(['Name', 'title'], ['Weekend', 'date'], ['Due date', 'date'])).date, 'Due date');
});
