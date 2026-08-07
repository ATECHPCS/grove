import { describe, expect, it } from 'vitest';
import { taskRelativeFilePath } from './fileNavigation';

describe('taskRelativeFilePath', () => {
  it('keeps task-relative paths unchanged', () => {
    expect(taskRelativeFilePath('chatbot_api/biz/tool.go', null)).toBe(
      'chatbot_api/biz/tool.go',
    );
  });

  it('converts an absolute Agent path to the Review tree path', () => {
    expect(
      taskRelativeFilePath(
        '/Users/example/work/ework_search/chatbot_api/biz/tool.go',
        '/Users/example/work/ework_search',
      ),
    ).toBe('chatbot_api/biz/tool.go');
  });

  it('waits for the task root before expanding an absolute path', () => {
    expect(taskRelativeFilePath('/Users/example/work/tool.go', null)).toBeNull();
  });

  it('does not expand absolute paths outside the task', () => {
    expect(
      taskRelativeFilePath(
        '/Users/example/other/tool.go',
        '/Users/example/work',
      ),
    ).toBeNull();
  });
});
