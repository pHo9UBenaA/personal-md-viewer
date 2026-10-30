const MIN_SIDEBAR_WIDTH_PX = 180;
const MAX_SIDEBAR_WIDTH_PX = 600;
const MOBILE_BREAKPOINT_PX = 760;
// Leave room for the reader plus the six-pixel resize handle.
const MIN_READER_AND_RESIZER_WIDTH_PX = 326;

export function initializeSidebarResize({ workspace, sidebar, resizer }) {
	let sidebarWidth = 250;
	let resizeOffset = 0;
	try {
		const saved = Number(localStorage.getItem("viewer-sidebar-width"));
		if (Number.isFinite(saved) && saved > 0) sidebarWidth = saved;
	} catch {
		/* Resizing still works without persistence. */
	}
	let preferredSidebarWidth = sidebarWidth;
	function sidebarMaxWidth() {
		return Math.max(
			MIN_SIDEBAR_WIDTH_PX,
			Math.min(
				MAX_SIDEBAR_WIDTH_PX,
				workspace.clientWidth - MIN_READER_AND_RESIZER_WIDTH_PX,
			),
		);
	}
	function setSidebarWidth(width, persist = false) {
		if (!Number.isFinite(width)) return;
		const maxWidth = sidebarMaxWidth();
		sidebarWidth = Math.round(
			Math.max(MIN_SIDEBAR_WIDTH_PX, Math.min(maxWidth, width)),
		);
		workspace.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
		resizer.setAttribute("aria-valuemax", String(maxWidth));
		resizer.setAttribute("aria-valuenow", String(sidebarWidth));
		if (persist) {
			preferredSidebarWidth = sidebarWidth;
			try {
				localStorage.setItem("viewer-sidebar-width", String(sidebarWidth));
			} catch {
				/* Resizing still works without persistence. */
			}
		}
	}
	setSidebarWidth(sidebarWidth);
	window.addEventListener("resize", () => {
		if (window.innerWidth > MOBILE_BREAKPOINT_PX)
			setSidebarWidth(preferredSidebarWidth);
	});
	resizer.addEventListener("pointerdown", (event) => {
		if (event.button !== 0) return;
		resizeOffset = event.clientX - sidebar.getBoundingClientRect().right;
		resizer.setPointerCapture(event.pointerId);
		resizer.focus();
		document.body.classList.add("resizing-sidebar");
	});
	resizer.addEventListener("pointermove", (event) => {
		if (resizer.hasPointerCapture(event.pointerId))
			setSidebarWidth(
				event.clientX - workspace.getBoundingClientRect().left - resizeOffset,
			);
	});
	function finishSidebarResize() {
		document.body.classList.remove("resizing-sidebar");
		setSidebarWidth(sidebarWidth, true);
	}
	resizer.addEventListener("pointerup", finishSidebarResize);
	resizer.addEventListener("pointercancel", finishSidebarResize);
	resizer.addEventListener("keydown", (event) => {
		const widthsByKey = {
			ArrowLeft: sidebarWidth - 20,
			ArrowRight: sidebarWidth + 20,
			Home: MIN_SIDEBAR_WIDTH_PX,
			End: sidebarMaxWidth(),
		};
		const width = widthsByKey[event.key];
		if (width === undefined) return;
		event.preventDefault();
		setSidebarWidth(width, true);
	});
}
