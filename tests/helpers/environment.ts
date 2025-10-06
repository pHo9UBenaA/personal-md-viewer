import { createMarkdownViewerEnvironment } from "../../src/runtime/environment";

export const createTestEnvironment = () => {
	const environment = createMarkdownViewerEnvironment();
	environment.sources.resetSources();
	return environment;
};
