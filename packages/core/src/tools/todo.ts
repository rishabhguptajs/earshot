import { arr, enumOf, object, requireArray, requireString, str } from './schema.ts';
import { defineTool, type TodoItem, type Tool, ToolInputError, text } from './types.ts';

interface TodoInput {
  items: TodoItem[];
}

const STATUSES = ['pending', 'in_progress', 'done'] as const;

/**
 * The list is replaced wholesale rather than patched. Incremental updates need
 * stable ids the model has to track across a long turn, and a model that loses
 * track produces a list that silently diverges from what it is doing; sending the
 * whole list every time makes the state the model believes in the state we show.
 */
export const todoTool: Tool<TodoInput> = defineTool<TodoInput>({
  name: 'todo',
  description:
    'Record the plan for a multi-step task, replacing the current list. Keep exactly ' +
    'one item in_progress, and mark items done as you finish them rather than in a ' +
    'batch at the end. Skip it for single-step work.',
  readOnly: true,
  inputSchema: object(
    {
      items: arr(
        object(
          {
            id: str('Stable identifier for the item.'),
            text: str('What the step is, in the imperative.'),
            status: enumOf([...STATUSES], 'pending, in_progress, or done.'),
          },
          ['id', 'text', 'status'],
        ),
        'The complete todo list, replacing any previous one.',
      ),
    },
    ['items'],
  ),
  parse: (input) => {
    const items = requireArray(input, 'items').map((raw, i) => {
      const status = requireString(raw, 'status');
      if (!(STATUSES as readonly string[]).includes(status)) {
        throw new ToolInputError(`item ${i + 1}: status must be one of ${STATUSES.join(', ')}`);
      }
      return {
        id: requireString(raw, 'id'),
        text: requireString(raw, 'text'),
        status: status as TodoItem['status'],
      };
    });
    const inProgress = items.filter((item) => item.status === 'in_progress');
    if (inProgress.length > 1) {
      throw new ToolInputError('only one item may be in_progress at a time');
    }
    return { items };
  },
  async execute(input, ctx) {
    ctx.todos.replace(input.items);
    const done = input.items.filter((item) => item.status === 'done').length;
    const rendered = input.items.map((item) => `${marker(item.status)} ${item.text}`).join('\n');
    return {
      output: text(rendered === '' ? 'todo list cleared' : rendered),
      title: `${done}/${input.items.length} done`,
    };
  },
});

function marker(status: TodoItem['status']): string {
  return status === 'done' ? '[x]' : status === 'in_progress' ? '[~]' : '[ ]';
}

/** The default in-memory store; the TUI reads it to render the status line. */
export class MemoryTodoStore {
  private items: TodoItem[] = [];

  list(): TodoItem[] {
    return [...this.items];
  }

  replace(items: TodoItem[]): void {
    this.items = [...items];
  }
}
