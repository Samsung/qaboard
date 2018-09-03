import React from "react";

const EmptyLoading = props => {
  if (props.error) {
    return <div>Error!</div>;
  } else {
    return <div></div>;
  }
};

export default EmptyLoading;