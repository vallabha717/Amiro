package auth

import "golang.org/x/crypto/bcrypt"

// bcryptCost matches golang.org/x/crypto/bcrypt's own recommended default
// (bcrypt.DefaultCost) rather than hand-picking a number -- plan section 3
// specifies bcrypt without mandating a cost, and the library default is the
// documented safe choice.
const bcryptCost = bcrypt.DefaultCost

func hashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

func verifyPassword(hash, password string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}
