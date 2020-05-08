---
id: tuning-workflows
sidebar_label: Tuning Workflows
title: "Various Tuning Workflows"
---
import useBaseUrl from '@docusaurus/useBaseUrl';


## Tuning from QA-Board
When doing QA or during development, you often want to run the code/configs from a given commit on new tests. QA-Board lets you define and runs batches of tests with extra tuning parameters:

<img alt="Tuning from the UI" src={useBaseUrl('img/tuning-from-the-ui.jpg')} />

## Investigating results/configs you see in the UI
Every time you see an output in the web application, you see what configurations were used, and you can easily open the output directory:

<img alt="Copy the Windows output dir" src={useBaseUrl('img/output-windows-dir.jpg')} />

<img alt="Output directory from Windows" src={useBaseUrl('img/winows-explorer-output-dir.jpg')} />

> The output logs always show you the exact CLI commands that were used, so that reproducing results is only a `git checkout $revision ; make ; qa run` away.


## Workflows used for Tuning
### **Local** Workflow
If you already have great development/debugging tools, use them!
- At SIRC, `CDE` provides a great environment to run hardware chains and view images.**
- For deep learning `tensorboard` is a great tool to investigate NNs.
- Many people love to write one-off `matlab` script.

> You can continue to use the existing tools!

This said, it's worth having your IDE/debugger/scripts call your code via QA-Board's `qa` CLI. [Here is how to do it](debugging).

### **Local configs > SharedStorage > Tuning from QA-Board** Workflow
> Details: WIP

### **Local > QA-Board** Workflow
QA-Board lets you runs your *local* code/configurations, and see results in the web application. **It gives you an easy way to tweak/compile/run your code and compare results across runs:**

```bash
qa --share run [...]
qa --share --label testing-some-logic-tweaks batch [...]
```

Results will appear in a new batch:

<img alt="selecting local runs" src={useBaseUrl('img/selecting-local-runs.jpg')} />
<img alt="local runs warning" src={useBaseUrl('img/local-runs-warning.jpg')} />


### **Commit > CI > QA-Board** Qorkflow
If you make changes in configuration files, you need to commit them.
1. Make changes
2. Commit the changes
3. Push your commit
4. See results in the UI
