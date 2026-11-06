import { computed, defineComponent, h, type Directive, type PropType } from 'vue';
import type { HoneypotTrapEvent } from './honeypot';
import { buildHoneypotSpec } from './honeypot';
import { guardInput, type GuardInputOptions } from './guard';

const DISPOSE = Symbol('aegis-dispose');
type Guarded = HTMLElement & { [DISPOSE]?: () => void };

/** `v-aegis-guard="{ onDetect, blockPasteAt }"` */
export const vAegisGuard: Directive<Guarded, GuardInputOptions | undefined> = {
  mounted(el, binding) {
    el[DISPOSE] = guardInput(el, binding.value ?? {});
  },
  updated(el, binding) {
    if (binding.value === binding.oldValue) return;
    el[DISPOSE]?.();
    el[DISPOSE] = guardInput(el, binding.value ?? {});
  },
  unmounted(el) {
    el[DISPOSE]?.();
    delete el[DISPOSE];
  },
};

/** `<AegisHoneypot seed="/pricing" trap-path="/__aegis/trap" @trap="..." />` */
export const AegisHoneypot = defineComponent({
  name: 'AegisHoneypot',
  props: {
    seed: { type: [String, Number] as PropType<string | number>, default: undefined },
    canary: { type: String, default: undefined },
    trapPath: { type: String, default: undefined },
    paragraphs: { type: Number, default: undefined },
    notice: { type: [String, Boolean] as PropType<string | false>, default: undefined },
  },
  emits: { trap: (_e: HoneypotTrapEvent) => true },
  setup(props, { emit }) {
    const spec = computed(() =>
      buildHoneypotSpec({
        ...(props.seed !== undefined ? { seed: props.seed } : {}),
        ...(props.canary ? { canary: props.canary } : {}),
        ...(props.trapPath ? { trapPath: props.trapPath } : {}),
        ...(props.paragraphs !== undefined ? { paragraphs: props.paragraphs } : {}),
        ...(props.notice !== undefined ? { notice: props.notice } : {}),
      }),
    );
    return () => {
      const { attrs, style, payload } = spec.value;
      return h(
        'div',
        {
          ...attrs,
          style,
          onClickCapture: (e: MouseEvent) => {
            const a = (e.target as Element | null)?.closest?.('a');
            if (!a) return;
            e.preventDefault();
            emit('trap', {
              type: 'link-click',
              href: a.getAttribute('href') ?? '',
              canary: payload.canary,
            });
          },
        },
        [
          payload.notice ? h('p', payload.notice) : null,
          ...payload.paragraphs.map((p) => h('p', p)),
          ...payload.links.map((l) =>
            h('a', { href: l.href, rel: 'nofollow noopener', tabindex: -1 }, l.text),
          ),
        ],
      );
    };
  },
});

/** Vue plugin: `app.use(PromptAegis)` registers the directive and component globally. */
export const PromptAegis = {
  install(app: {
    directive(name: string, d: Directive): unknown;
    component(name: string, c: unknown): unknown;
  }) {
    app.directive('aegis-guard', vAegisGuard as Directive);
    app.component('AegisHoneypot', AegisHoneypot);
  },
};
