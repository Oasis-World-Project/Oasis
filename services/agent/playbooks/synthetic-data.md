# 合成数据

> 适用：问答数据集、领域合成样本、微调数据、批量生成、质量评分与过滤。

- `text.batch --in 提示.jsonl --out 结果.jsonl` 按行生成，`jev.decide --in … --out …` 按行评分；都按行计费，中断后同一 `--out` 加 `--resume true` 接着跑。
- 数量要求按去重、过滤后的有效行算。沙箱有 pandas、pyarrow。
