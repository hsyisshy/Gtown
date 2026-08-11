let dpad = null;
let cleanup = [];

const DIRECTIONS = [
  { key: 'up', dx: 0, dy: -1 },
  { key: 'down', dx: 0, dy: 1 },
  { key: 'left', dx: -1, dy: 0 },
  { key: 'right', dx: 1, dy: 0 },
];

export function mount(root, sendFn) {
  root.innerHTML = `
    <div class="gamepad-layout">
      <div class="gamepad-left">
        <div id="dpad-container"></div>
      </div>
      <div class="gamepad-right">
        <div class="abxy-buttons">
          <button class="abxy-btn btn-y" data-action="reroll">換物件</button>
          <button class="abxy-btn btn-x" data-rotation="-1">↺</button>
          <button class="abxy-btn btn-b" data-action="b">放下</button>
          <button class="abxy-btn btn-a" data-rotation="1">↻</button>
        </div>
      </div>
    </div>
  `;

  dpad = createDpad(
    root.querySelector('#dpad-container'),
    ({ dx }) => sendFn({ action: 'move', dx: dx ?? 0 }),
    { disabled: ['up', 'down'] },
  );

  root.querySelectorAll('[data-rotation]').forEach((button) => {
    const direction = Number(button.dataset.rotation);
    const press = (event) => {
      event.preventDefault();
      button.classList.add('pressed');
      sendFn({ action: 'rotate', direction });
    };
    const release = () => {
      button.classList.remove('pressed');
      sendFn({ action: 'rotate', direction: 0 });
    };

    button.addEventListener('pointerdown', press);
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('pointerleave', release);
    cleanup.push(() => {
      button.removeEventListener('pointerdown', press);
      button.removeEventListener('pointerup', release);
      button.removeEventListener('pointercancel', release);
      button.removeEventListener('pointerleave', release);
    });
  });

  root.querySelectorAll('[data-action]').forEach((button) => {
    const action = button.dataset.action;
    const press = (event) => {
      event.preventDefault();
      button.classList.add('pressed');
      sendFn({ action });
    };
    const release = () => button.classList.remove('pressed');

    button.addEventListener('pointerdown', press);
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    cleanup.push(() => {
      button.removeEventListener('pointerdown', press);
      button.removeEventListener('pointerup', release);
      button.removeEventListener('pointercancel', release);
    });
  });
}

export function unmount() {
  dpad?.destroy();
  dpad = null;
  cleanup.forEach(fn => fn());
  cleanup = [];
}

function createDpad(container, onMove, options = {}) {
  const disabled = new Set(options.disabled ?? []);
  const pressed = new Set();
  const localCleanup = [];
  const grid = document.createElement('div');
  grid.className = 'dpad-buttons';

  function emit() {
    const dx = (pressed.has('right') ? 1 : 0) - (pressed.has('left') ? 1 : 0);
    const dy = (pressed.has('down') ? 1 : 0) - (pressed.has('up') ? 1 : 0);
    onMove({ dx, dy });
  }

  for (const { key } of DIRECTIONS) {
    const isDisabled = disabled.has(key);
    const button = document.createElement('button');
    button.className = `dpad-btn dpad-${key}${isDisabled ? ' inactive' : ''}`;
    button.innerHTML = '<svg viewBox="0 0 24 24" class="dpad-chevron"><path d="M7 15 L12 9 L17 15" /></svg>';
    if (!isDisabled) {
      const press = (event) => {
        event.preventDefault();
        pressed.add(key);
        button.classList.add('pressed');
        emit();
      };
      const release = () => {
        pressed.delete(key);
        button.classList.remove('pressed');
        emit();
      };
      button.addEventListener('pointerdown', press);
      button.addEventListener('pointerup', release);
      button.addEventListener('pointercancel', release);
      localCleanup.push(() => {
        button.removeEventListener('pointerdown', press);
        button.removeEventListener('pointerup', release);
        button.removeEventListener('pointercancel', release);
      });
    }
    grid.appendChild(button);
  }

  container.appendChild(grid);
  return {
    destroy() {
      localCleanup.forEach((fn) => fn());
      grid.remove();
    },
  };
}
