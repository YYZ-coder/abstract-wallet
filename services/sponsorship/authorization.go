package sponsorship

import (
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/holiman/uint256"
)

func authTuple(a J) types.SetCodeAuthorization {
	r, _ := new(big.Int).SetString(strings.TrimPrefix(a["r"].(string), "0x"), 16)
	s, _ := new(big.Int).SetString(strings.TrimPrefix(a["s"].(string), "0x"), 16)
	return types.SetCodeAuthorization{ChainID: *uint256.MustFromBig(integer(a["chainId"])), Address: common.HexToAddress(a["address"].(string)), Nonce: integer(a["nonce"]).Uint64(), V: uint8(integer(a["yParity"]).Uint64()), R: *uint256.MustFromBig(r), S: *uint256.MustFromBig(s)}
}
func validAuthorization(a, ctx J, account string) bool {
	for _, k := range []string{"chainId", "address", "nonce"} {
		if a[k] != ctx[k] {
			return false
		}
	}
	auth := authTuple(a)
	addr, e := auth.Authority()
	return e == nil && strings.ToLower(addr.Hex()) == account
}
