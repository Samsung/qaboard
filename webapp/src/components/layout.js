import styled from "styled-components";


const Container = styled.div`
  padding-left: 0;
  list-style: none;
  margin-top: 20px;
  margin-bottom: 10px;
  box-sizing: border-box;

  padding-right: 15px;
  padding-left: 15px;
  margin-right: auto;
  margin-left: auto;
  @media (min-width: 768px) {
    width: 750px;
  }
  @media (min-width: 992px) {
    width: 970px;
  }
  @media (min-width: 1300px) {
    width: 1270px;
  }
`;

const Section = styled.div`
  margin-bottom: 40px;
  margin-top: 30px;
  width: fit-content;
`;



const Layout = styled.div`
  display: flex;
  flex: auto;
  flex-direction: row;
  box-sizing: border-box;
  // style
  background: #f0f2f5;
  min-height: 750px;
`

export { Container, Section, Layout };
