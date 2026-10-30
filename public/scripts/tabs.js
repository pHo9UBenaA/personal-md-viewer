export class TabSelection {
	keys = new Set();
	anchor = null;

	selectOnly(key) {
		this.keys = new Set(key ? [key] : []);
		this.anchor = key;
	}

	selectRange(key, orderedKeys) {
		const start = orderedKeys.indexOf(this.anchor);
		const end = orderedKeys.indexOf(key);
		if (start < 0 || end < 0) {
			this.selectOnly(key);
			return;
		}
		this.keys = new Set(
			orderedKeys.slice(Math.min(start, end), Math.max(start, end) + 1),
		);
	}

	retain(orderedKeys, active) {
		this.keys = new Set(orderedKeys.filter((key) => this.keys.has(key)));
		if (!this.keys.size && active) this.keys.add(active);
		if (!orderedKeys.includes(this.anchor)) this.anchor = active;
	}
}

export function initializeTabs({
	element,
	menu,
	tabs,
	getActive,
	activate,
	closeTabs,
	reorderTabs,
	reloadTab,
	status,
}) {
	const selection = new TabSelection();
	let menuKey = null;
	let dragKey = null;
	const selectedKeys = () =>
		[...tabs.keys()].filter((key) => selection.keys.has(key));
	const tabFor = (key) =>
		[...element.querySelectorAll('[role="tab"]')].find(
			(tab) => tab.closest(".tab").dataset.key === key,
		);

	function closeMenu(restoreFocus = false) {
		menu.hidden = true;
		if (restoreFocus) tabFor(menuKey)?.focus();
		menuKey = null;
	}

	function selectAndActivate(key, extend = false) {
		if (extend) selection.selectRange(key, [...tabs.keys()]);
		else selection.selectOnly(key);
		void activate(key, { preserveTabSelection: true });
	}

	function draw() {
		closeMenu();
		selection.retain([...tabs.keys()], getActive());
		element.replaceChildren();
		for (const [key, doc] of tabs) {
			const tab = document.createElement("button");
			tab.type = "button";
			tab.textContent = doc.name;
			tab.setAttribute("role", "tab");
			tab.setAttribute("aria-selected", String(getActive() === key));
			tab.setAttribute("aria-controls", "reader");
			if (selection.keys.has(key))
				tab.setAttribute("aria-description", "一括で閉じる対象のタブ");
			tab.tabIndex = getActive() === key ? 0 : -1;
			tab.title = doc.path ?? doc.label;
			tab.id = `tab-${doc.id}`;
			tab.addEventListener("click", (event) => {
				selectAndActivate(key, event.shiftKey);
				tabFor(key)?.focus();
			});
			const close = document.createElement("button");
			close.type = "button";
			close.textContent = "×";
			close.className = "close-tab";
			close.setAttribute("aria-label", `${doc.label} を閉じる`);
			close.addEventListener("click", () => closeTabs([key]));
			const group = document.createElement("div");
			group.className = "tab";
			group.setAttribute("role", "presentation");
			group.dataset.key = key;
			group.dataset.batchSelected = String(selection.keys.has(key));
			group.draggable = true;
			group.append(tab, close);
			element.append(group);
		}
	}

	function moveBefore(key, beforeKey) {
		if (key === beforeKey) return;
		const keys = [...tabs.keys()].filter((item) => item !== key);
		const index = beforeKey === null ? keys.length : keys.indexOf(beforeKey);
		if (index < 0) return;
		keys.splice(index, 0, key);
		reorderTabs(keys);
	}

	function moveBy(key, direction) {
		const keys = [...tabs.keys()];
		const index = keys.indexOf(key);
		const nextIndex = index + direction;
		if (nextIndex < 0 || nextIndex >= keys.length) return;
		[keys[index], keys[nextIndex]] = [keys[nextIndex], keys[index]];
		reorderTabs(keys);
		tabFor(key)?.focus();
	}

	async function copyPath(path) {
		try {
			if (!navigator.clipboard) throw new Error();
			await navigator.clipboard.writeText(path);
			status("ファイルパスをコピーしました。");
		} catch {
			status(
				"パスをコピーできませんでした。ブラウザーのクリップボード権限を確認してください。",
				true,
			);
		}
	}

	function openMenu(key, x, y) {
		if (!selection.keys.has(key)) {
			selection.selectOnly(key);
			draw();
		}
		menuKey = key;
		const doc = tabs.get(key);
		const keys = [...tabs.keys()];
		const index = keys.indexOf(key);
		const actions = [
			["絶対パスをコピー", () => copyPath(doc.path)],
			["content/ 基準の相対パスをコピー", () => copyPath(doc.relativePath)],
			["再読み込み", () => reloadTab(key)],
			["左へ移動", () => moveBy(key, -1), index === 0],
			["右へ移動", () => moveBy(key, 1), index === keys.length - 1],
			["このタブを閉じる", () => closeTabs([key])],
			[
				`選択したタブを閉じる (${selection.keys.size})`,
				() => closeTabs(selectedKeys()),
			],
			[
				"ほかのタブを閉じる",
				() => closeTabs(keys.filter((item) => item !== key)),
				keys.length === 1,
			],
			[
				"右側のタブを閉じる",
				() => closeTabs(keys.slice(index + 1)),
				index === keys.length - 1,
			],
			["すべて閉じる", () => closeTabs(keys)],
		];
		menu.replaceChildren(
			...actions.map(([label, action, disabled]) => {
				const item = document.createElement("button");
				item.type = "button";
				item.setAttribute("role", "menuitem");
				item.textContent = label;
				item.disabled = Boolean(disabled);
				item.addEventListener("click", () => {
					closeMenu(true);
					void action();
				});
				return item;
			}),
		);
		menu.hidden = false;
		menu.style.left = `${Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8))}px`;
		menu.style.top = `${Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`;
		menu.querySelector("button:not(:disabled)")?.focus();
	}

	element.addEventListener("contextmenu", (event) => {
		const group = event.target.closest(".tab");
		if (!group) return;
		event.preventDefault();
		const rect = group.getBoundingClientRect();
		openMenu(
			group.dataset.key,
			event.clientX || rect.left,
			event.clientY || rect.bottom,
		);
	});
	element.addEventListener("keydown", (event) => {
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		const keys = [...tabs.keys()];
		const key = event.target.closest(".tab")?.dataset.key;
		if (!key) return;
		let index = keys.indexOf(key);
		if (event.key === "ArrowRight") index = (index + 1) % keys.length;
		else if (event.key === "ArrowLeft")
			index = (index - 1 + keys.length) % keys.length;
		else if (event.key === "Home") index = 0;
		else if (event.key === "End") index = keys.length - 1;
		else if (event.key === "Delete" || event.key === "Backspace") {
			event.preventDefault();
			closeTabs(selectedKeys());
			return;
		} else if (event.key === "F10" && event.shiftKey) {
			event.preventDefault();
			const rect = tabFor(key).getBoundingClientRect();
			openMenu(key, rect.left, rect.bottom);
			return;
		} else return;
		event.preventDefault();
		selectAndActivate(keys[index], event.shiftKey);
		tabFor(keys[index])?.focus();
	});
	menu.addEventListener("keydown", (event) => {
		if (event.key === "Escape" || event.key === "Tab") {
			event.preventDefault();
			event.stopPropagation();
			closeMenu(true);
			return;
		}
		const items = [...menu.querySelectorAll("button:not(:disabled)")];
		let index = items.indexOf(document.activeElement);
		if (event.key === "ArrowDown") index = (index + 1) % items.length;
		else if (event.key === "ArrowUp")
			index = (index - 1 + items.length) % items.length;
		else if (event.key === "Home") index = 0;
		else if (event.key === "End") index = items.length - 1;
		else return;
		event.preventDefault();
		items[index].focus();
	});
	document.addEventListener("pointerdown", (event) => {
		if (!menu.contains(event.target)) closeMenu();
	});
	document.addEventListener("focusin", (event) => {
		if (!menu.contains(event.target)) closeMenu();
	});
	window.addEventListener("resize", () => closeMenu());
	document.addEventListener("scroll", () => closeMenu(), true);

	function clearDropIndicator() {
		for (const group of element.children) delete group.dataset.dropPosition;
	}
	function dropTarget(event) {
		const group = event.target.closest(".tab");
		if (!group) return { beforeKey: null };
		const rect = group.getBoundingClientRect();
		const before = event.clientX < rect.left + rect.width / 2;
		const keys = [...tabs.keys()];
		return {
			group,
			before,
			beforeKey: before
				? group.dataset.key
				: (keys[keys.indexOf(group.dataset.key) + 1] ?? null),
		};
	}
	element.addEventListener("dragstart", (event) => {
		const group = event.target.closest(".tab");
		if (!group) return;
		closeMenu();
		dragKey = group.dataset.key;
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData("application/x-mdv-tab", dragKey);
	});
	element.addEventListener("dragover", (event) => {
		if (!dragKey || event.dataTransfer.types.includes("Files")) return;
		event.preventDefault();
		event.stopPropagation();
		event.dataTransfer.dropEffect = "move";
		clearDropIndicator();
		const { group, before } = dropTarget(event);
		if (group) group.dataset.dropPosition = before ? "before" : "after";
	});
	element.addEventListener("drop", (event) => {
		if (!dragKey || event.dataTransfer.types.includes("Files")) return;
		event.preventDefault();
		event.stopPropagation();
		const key = dragKey;
		dragKey = null;
		clearDropIndicator();
		moveBefore(key, dropTarget(event).beforeKey);
	});
	element.addEventListener("dragend", () => {
		dragKey = null;
		clearDropIndicator();
	});

	return {
		draw,
		selectOnly: (key) => selection.selectOnly(key),
		selectedKeys,
		closeMenu,
	};
}
