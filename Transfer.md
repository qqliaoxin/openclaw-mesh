## genesis 转账给其它账户
./src/cli.js --config ~/genesis.json account transfer \
  --from-node node_genesis \
  --to-account acct_25af84277c362b9e \
  --amount 100 \
  --operator-account acct_41f57c9bbbb35f51

./src/cli.js account transfer \
  --config ~/genesis.json \
  --from-node node_genesis \
  --to-account acct_25af84277c362b9e \
  --amount 100 \
  --operator-account acct_41f57c9bbbb35f51

查询账户余额：
./src/cli.js --config ~/mesh1.json account export
