# qwenn3-bybit-trading-bot

Basic qwenn3-max trading bot inspired with:
  - https://github.com/HammerGPT/Hyper-Alpha-Arena?tab=readme-ov-file
  - https://nof1.ai

Strategy is defined by bot. 
Bot places futures trading orders with stop losses and take profit at Bybit-exchange based on qwenn3-max decision. 

## Requirements
- node and npm
- telegram group id and api key
- Bybit secret and public api key with permissions
- some latest news json api key access
- qwenn3/chatgpt api host and key

## Instruction

- maybe you will need remove news parsing and prompt injection 
- setup .env file with your credendtilas
- ```npm i```
- ```node index.js```
