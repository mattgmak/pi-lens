// Fixture for the auxiliary-LSP harness layer: Opengrep's login-free `auto`
// Community ruleset flags `eval(<non-literal>)` (code injection). The harness
// drives this through the with-auxiliary touchFile path and asserts the
// opengrep (source "Semgrep") diagnostic comes back.
function run(userInput) {
	return eval(userInput);
}

module.exports = { run };
