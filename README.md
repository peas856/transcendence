# transcendence

즐~~~~~거운 웹서비스

## 설치

### 환경 변수

- 환경 변수는 `transcendence/dotenv` 서브모듈에 있습니다

```bash
git config --global submodule.recurse true # 중첩 pull 옵션
git submodule update --init --recursive
```

을 하여 서브모듈을 초기화하세요

개발모드:
`./dc.sh dev up --build`

프로덕션 모드:
`./dc.sh prod up --build`

dc.sh에서 npm ci이 되어있지 않을 때 자동으로 install하는 로직이 들어있지만, 잘 작동하지 않는 경우 install.sh를 실행해주세요

## 문서

### swagger

http://localhost:3000/api

### webscoket api

http://localhost:3000/api-ws

### storybook 컴포넌트 라이브러리

http://localhost:3000/storybook
