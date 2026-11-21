import {
  autocomplete,
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";

export const CANCEL = Symbol("pickagent.cancel");
export type Cancel = typeof CANCEL;

export function isPromptCancel(value: unknown): value is Cancel {
  return value === CANCEL;
}

export type PromptOption<Value extends string = string> = {
  value: Value;
  label?: string;
  hint?: string;
  disabled?: boolean;
};

export type ScanPrompts = {
  intro(message: string): void;
  outro(message: string): void;
  cancel(message: string): void;
  note(message: string, title?: string): void;
  spin<T>(message: string, task: () => Promise<T>): Promise<T>;
  multiselect(input: {
    message: string;
    options: readonly PromptOption[];
    initialValues?: readonly string[];
    required?: boolean;
  }): Promise<string[] | Cancel>;
  select(input: {
    message: string;
    options: readonly PromptOption[];
    initialValue?: string;
  }): Promise<string | Cancel>;
  autocomplete(input: {
    message: string;
    options: readonly PromptOption[];
    placeholder?: string;
  }): Promise<string | Cancel>;
  text(input: {
    message: string;
    initialValue?: string;
    placeholder?: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string | Cancel>;
  confirm(input: { message: string }): Promise<boolean | Cancel>;
};

function asCancel<T>(value: T | symbol): T | Cancel {
  return isCancel(value) ? CANCEL : value;
}

/** @clack/prompts adapter. Bundled into dist/cli.js. */
export function clackPrompts(): ScanPrompts {
  return {
    intro(message) {
      intro(message);
    },
    outro(message) {
      outro(message);
    },
    cancel(message) {
      cancel(message);
    },
    note(message, title) {
      note(message, title);
    },
    async spin(message, task) {
      const spin = spinner();
      spin.start(message);
      try {
        const result = await task();
        spin.stop(message);
        return result;
      } catch (error) {
        spin.error(message);
        throw error;
      }
    },
    async multiselect(input) {
      const value = await multiselect({
        message: input.message,
        options: [...input.options],
        initialValues: input.initialValues ? [...input.initialValues] : undefined,
        required: input.required ?? false,
      });
      return asCancel(value);
    },
    async select(input) {
      const value = await select({
        message: input.message,
        options: [...input.options],
        initialValue: input.initialValue,
      });
      return asCancel(value);
    },
    async autocomplete(input) {
      const value = await autocomplete({
        message: input.message,
        options: [...input.options],
        placeholder: input.placeholder,
      });
      return asCancel(value);
    },
    async text(input) {
      const value = await text({
        message: input.message,
        initialValue: input.initialValue,
        placeholder: input.placeholder,
        validate: input.validate,
      });
      return asCancel(value);
    },
    async confirm(input) {
      const value = await confirm({ message: input.message });
      return asCancel(value);
    },
  };
}
