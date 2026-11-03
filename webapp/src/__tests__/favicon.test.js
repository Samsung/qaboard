/**
 * The tab's icon shows the status of the runs with a dot drawn over the site's icon.
 * Run with: cd webapp && npm test -- favicon
 */
import { set_favicon_state, reset_favicon } from '../favicon';

const icon32 = 'http://localhost/favicon-32x32.png';
const icon16 = 'http://localhost/favicon-16x16.png';
const hrefs = () => Array.from(document.querySelectorAll('link[rel="icon"]')).map(link => link.href);

beforeEach(() => {
  document.head.innerHTML = `<link rel="icon" sizes="32x32" href="${icon32}"><link rel="icon" sizes="16x16" href="${icon16}">`;
  reset_favicon();
});

test('draws each state once over the largest icon, and restores the icon without a state', async () => {
  const draw = vi.fn(async state => `data:${state}`);
  await set_favicon_state('running', { draw });
  expect(draw).toHaveBeenCalledWith('running', icon32);
  expect(hrefs()).toEqual(['data:running', 'data:running']);
  await set_favicon_state('failed', { draw });
  expect(hrefs()).toEqual(['data:failed', 'data:failed']);
  await set_favicon_state('running', { draw });
  expect(draw).toHaveBeenCalledTimes(2);
  await set_favicon_state(null, { draw });
  expect(hrefs()).toEqual([icon32, icon16]);
});

test('keeps the plain icon when the dot cannot be drawn', async () => {
  await set_favicon_state('running', { draw: async () => { throw new Error('no canvas'); } });
  expect(hrefs()).toEqual([icon32, icon16]);
  await set_favicon_state('running', { draw: async () => null });
  expect(hrefs()).toEqual([icon32, icon16]);
});

test('a slow drawing does not overwrite a newer state', async () => {
  let finish_running;
  const draw = vi.fn(state => state === 'running' ? new Promise(resolve => { finish_running = resolve; }) : Promise.resolve(`data:${state}`));
  const running = set_favicon_state('running', { draw });
  await set_favicon_state('failed', { draw });
  finish_running('data:running');
  await running;
  expect(hrefs()).toEqual(['data:failed', 'data:failed']);
});
