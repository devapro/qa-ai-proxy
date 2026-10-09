import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { checkSpecs, specificationsFromCases, specsFromCases } from './check_proxy_specs.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const FIXTURE_SCENARIO = `export default {
    name: 'credits',
    description: 'Fixture scenario for check_proxy_specs tests.',
    params: { quotaLeft: 480 },
    http: [
        {
            method: 'GET',
            path: '/credits',
            onResponse(response, { params }) {
                return { status: 200, json: { left: params.quotaLeft, cost: params.cost } };
            },
        },
    ],
};
`;

function specs(text) {
    return specsFromCases(text, 'plan.md').map(({ spec, route }) => ({ spec, route }));
}

describe('specsFromCases', () => {
    test('reads a backticked Markdown spec', () => {
        assert.deepEqual(specs('**Precondition:** QA proxy scenario `credits:quotaLeft=0`'), [
            { spec: 'credits:quotaLeft=0', route: false },
        ]);
    });

    test('reads a Jira wiki {{spec}}', () => {
        assert.deepEqual(specs('*Precondition:* QA proxy: {{ai-credits:quotaLeft=0}}'), [
            { spec: 'ai-credits:quotaLeft=0', route: false },
        ]);
    });

    test('reads every spec chained with + on one line', () => {
        assert.deepEqual(specs('QA proxy: {{a:x=1}} + {{b}} + `c:y=2`'), [
            { spec: 'a:x=1', route: false },
            { spec: 'b', route: false },
            { spec: 'c:y=2', route: false },
        ]);
    });

    test('marks an HTTP route as a route, not a spec', () => {
        assert.deepEqual(specs('QA proxy: {{POST /assistant/v1/chat}} → HTTP 402'), [
            { spec: 'POST /assistant/v1/chat', route: true },
        ]);
    });

    test('reports each spec once, at its first line', () => {
        const found = specsFromCases('QA proxy `credits`\n\nQA proxy `credits`', 'plan.md');

        assert.deepEqual(found, [{ spec: 'credits', source: 'plan.md:1', route: false }]);
    });

    test('ignores a backticked token far from the words "QA proxy"', () => {
        assert.deepEqual(specs(`QA proxy ${'x'.repeat(60)} \`credits\``), []);
    });
});


const MARKDOWN_SPECIFICATION = `# Cases

## QA proxy scenarios

Scenarios the run writes before the proxy starts.

### \`comments-pro-author\`

- **State:** every comment author is a Pro user.
- **Rewrites:** \`GET /comments_api.php\` → every \`comments[].is_pro_user\` = \`true\`.
- **Params:** \`proUser\` (default \`true\`)
- **The app also needs:** a news article with comments.
- **Cases:** TC-1, TC-2

### \`credits\`

- **Params:** \`cost\` (default \`20\`)
- **Cases:** TC-3

## Comments

### TC-1: Comments - Guest - avatar tap

**Precondition:** QA proxy: \`comments-pro-author\`
`;

const WIKI_SPECIFICATION = `h2. AND-1 - Analytics Test Cases
h3. QA proxy scenarios
h4. {{comments-pro-author}}
* *State:* every comment author is a Pro user.
* *Rewrites:* {{GET /comments_api.php}} → {{comments[].is_pro_user}} = {{true}}.
* *Params:* {{proUser}} (default {{true}})
* *Cases:* TC-1
h3. TC-1: Comments - Guest - avatar tap
*Precondition:* QA proxy: {{comments-pro-author}}
`;

describe('specificationsFromCases', () => {
    test('reads every entry of a Markdown "QA proxy scenarios" section with its fields', () => {
        const found = specificationsFromCases(MARKDOWN_SPECIFICATION, 'plan.md');

        assert.deepEqual(found, [
            {
                name: 'comments-pro-author',
                source: 'plan.md:7',
                state: 'every comment author is a Pro user.',
                rewrites: '`GET /comments_api.php` → every `comments[].is_pro_user` = `true`.',
                params: '`proUser` (default `true`)',
                needs: 'a news article with comments.',
                cases: ['TC-1', 'TC-2'],
            },
            { name: 'credits', source: 'plan.md:15', state: '', rewrites: '', params: '`cost` (default `20`)', needs: '', cases: ['TC-3'] },
        ]);
    });

    test('reads a Jira wiki section', () => {
        const [found] = specificationsFromCases(WIKI_SPECIFICATION, 'plan.txt');

        assert.equal(found.name, 'comments-pro-author');
        assert.equal(found.source, 'plan.txt:3');
        assert.equal(found.params, '{{proUser}} (default {{true}})');
        assert.deepEqual(found.cases, ['TC-1']);
    });

    test('stops at the next heading of the section level, so a case heading is never an entry', () => {
        const found = specificationsFromCases(MARKDOWN_SPECIFICATION, 'plan.md');

        assert.deepEqual(found.map((entry) => entry.name), ['comments-pro-author', 'credits']);
    });

    test('finds nothing in a plan without the section', () => {
        assert.deepEqual(specificationsFromCases('**Precondition:** QA proxy `credits`', 'plan.md'), []);
    });
});

describe('checkSpecs', () => {
    let proxyDir;

    before(async () => {
        proxyDir = await mkdtemp(path.join(os.tmpdir(), 'check-proxy-specs-'));
        await symlink(path.join(repoRoot, 'qa-proxy', 'src'), path.join(proxyDir, 'src'), 'dir');
        await mkdir(path.join(proxyDir, 'scenarios'));
        await writeFile(path.join(proxyDir, 'scenarios', 'credits.js'), FIXTURE_SCENARIO);
    });

    after(async () => {
        await rm(proxyDir, { recursive: true, force: true });
    });

    const check = async (spec, extra = {}) => (await checkSpecs([{ spec, source: 'test', ...extra }], proxyDir));
    const kinds = (report) => report.specs.flatMap((result) => result.problems.map((problem) => problem.kind));

    test('accepts a known scenario with a param it reads, merging defaults', async () => {
        const report = await check('credits:cost=5');

        assert.equal(report.ok, true);
        assert.deepEqual(report.specs[0].entries, [{ name: 'credits', params: { quotaLeft: 480, cost: 5 } }]);
    });

    test('reports an unknown scenario the plan does not specify as UNSPECIFIED_SCENARIO', async () => {
        const report = await check('assistant-chat-status:status=402');

        assert.equal(report.ok, false);
        assert.equal(report.preparable, false);
        assert.deepEqual(kinds(report), ['UNSPECIFIED_SCENARIO']);
    });

    test('reports an unknown scenario the plan specifies as a preparable MISSING_SCENARIO', async () => {
        const specifications = specificationsFromCases(MARKDOWN_SPECIFICATION, 'plan.md');
        const report = await checkSpecs([{ spec: 'comments-pro-author', source: 'test' }], proxyDir, specifications);

        assert.equal(report.ok, false);
        assert.equal(report.preparable, true);
        assert.deepEqual(kinds(report), ['MISSING_SCENARIO']);
        assert.equal(report.specs[0].problems[0].specified, true);
        assert.match(report.specs[0].problems[0].detail, /specified in the cases \(plan\.md:7\): rewrites GET \/comments_api\.php/);
        assert.equal(report.specifications, specifications);
    });

    test('a specified param an existing scenario does not read yet is a preparable UNREAD_PARAM', async () => {
        const specifications = specificationsFromCases(MARKDOWN_SPECIFICATION, 'plan.md');
        const report = await checkSpecs([{ spec: 'credits:cost=5:typo=1', source: 'test' }], proxyDir, specifications);

        assert.equal(report.preparable, false);
        assert.deepEqual(
            report.specs[0].problems.map((problem) => [problem.kind, problem.param, problem.specified]),
            [['UNREAD_PARAM', 'typo', false]],
        );

        const extended = await checkSpecs([{ spec: 'credits:quotaLeft=0:cost=5', source: 'test' }], proxyDir, [
            { name: 'credits', params: '`quotaLeft` (default `480`)', source: 'plan.md:1' },
        ]);
        assert.equal(extended.ok, true);
    });

    test('an unspecified scenario next to a specified one leaves the plan not preparable', async () => {
        const specifications = specificationsFromCases(MARKDOWN_SPECIFICATION, 'plan.md');
        const report = await checkSpecs(
            [{ spec: 'comments-pro-author', source: 'a' }, { spec: 'other', source: 'b' }],
            proxyDir,
            specifications,
        );

        assert.equal(report.preparable, false);
        assert.deepEqual(kinds(report), ['MISSING_SCENARIO', 'UNSPECIFIED_SCENARIO']);
    });

    test('reports a param the scenario never reads as UNREAD_PARAM', async () => {
        const report = await check('credits:typo=1');

        assert.deepEqual(kinds(report), ['UNREAD_PARAM']);
        assert.equal(report.preparable, false);
    });

    test('reports a param written with "," as SYNTAX', async () => {
        assert.deepEqual(kinds(await check('credits:quotaLeft=0,cost=5')), ['SYNTAX']);
    });

    test('reports a route as DESCRIBED_NEED', async () => {
        const report = await check('POST /assistant/v1/chat', { route: true });

        assert.equal(report.ok, false);
        assert.deepEqual(kinds(report), ['DESCRIBED_NEED']);
    });

    test('is runnable when no spec is given', async () => {
        assert.deepEqual(await checkSpecs([], proxyDir), { ok: true, preparable: true, loadProblems: [], specifications: [], specs: [] });
    });
});
