import { computed, defineComponent, h, onMounted, ref, type Directive, type PropType } from 'vue';
import { isSearchEngine } from '@prompt-aegis/core';
import type { HoneypotTrapEvent } from './honeypot';
import { buildHoneypotSpec } from './honeypot';
import { guardInput, liveGuardOptions, type GuardInputOptions } from './guard';

const DISPOSE = Symbol('aegis-dispose');
const OPTIONS = Symbol('aegis-options');
type Guarded = HTMLElement & { [DISPOSE]?: () => void; [OPTIONS]?: GuardInputOptions };

/**
 * `v-aegis-guard="{ onDetect, blockPasteAt }"`. Options are read live, so an
 * inline object literal does not re-bind listeners on every render.
 */
export const vAegisGuard: Directive<Guarded, GuardInputOptions | undefined> = {
  mounted(el, binding) {
    el[OPTIONS] = binding.value ?? {};
    el[DISPOSE] = guardInput(
      el,
      liveGuardOptions(() => el[OPTIONS]),
    );
  },
  updated(el, binding) {
    el[OPTIONS] = binding.value ?? {};
  },
  unmounted(el) {
    el[DISPOSE]?.();
    delete el[DISPOSE];
    delete el[OPTIONS];
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
    /** Remove the honeypot for search-engine crawlers after mount. Default `true`. */
    skipSearchEngines: { type: Boolean, default: true },
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
    const hidden = ref(false);
    onMounted(() => {
      if (props.skipSearchEngines && isSearchEngine(navigator.userAgent)) hidden.value = true;
    });
    return () => {
      if (hidden.value) return null;
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
